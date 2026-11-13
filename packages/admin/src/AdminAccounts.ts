// @awthaq/admin — AdminAccounts
//
// BAM-005/BAM-009 (BEH-EA-221, BEH-EA-224): deleting a user, setting a user's email and setting a
// user's password, as an opt-in plugin beside `Admin` and `Password`:
// `Auth.make([Admin, Password, AdminAccounts])` (it lists `Password` in `dependsOn`, ADR-EA-048).
// Every operation is behind its own fail-closed predicate (`AdminConfig.canDeleteUsers`,
// `canManageCredentials`), gate first and existence second, and publishes an audited
// `auth.admin.*` event naming the administrator.
//
// - `deleteUser` does not run a cascade of its own. It is `AccountErasure.eraseAccount` — the
//   one erasure cascade the self-service `DELETE /account` also runs (accounts, sessions,
//   verification tokens, every registered erasure contribution, audit pseudonymization, the
//   `BeforeUserDelete` veto) — so an admin delete and a self delete cannot diverge.
// - `setUserEmail` never edits the address on the administrator's say-so: it mails a
//   `change-email` token (`EmailChange`, shared with the user's own request) to the *new* address,
//   and the address is replaced only when its owner confirms at `POST /change-email/confirm`
//   (`@awthaq/password`), which also marks it verified. That endpoint is part of the password
//   plugin, so a deployment without it can request but not complete a change.
// - `setUserPassword` never touches the credential or a hasher itself: `Password`'s exposed
//   `PasswordCredential` checks the password against `Password.config`'s policy in force for the
//   request's tenant (minimum length, breach screening; BEH-EA-120) before anything is written,
//   then, inside one transaction, replaces the credential — or creates the password credential if
//   the user had none — while every session of the user is revoked (reason `admin`), so a session
//   an attacker held does not survive the reset. It consults `Hooks.BeforeCredentialReset`
//   (ARF-005) with no second-factor code, exactly like a self-service reset that has none: for a
//   user protected by a second factor the veto refuses (`HookAborted`, code `TWO_FACTOR_REQUIRED`)
//   and nothing is written. An administrator cannot supply the user's factor, so the safe default
//   is that an admin cannot silently replace the password of an MFA-protected account; a
//   deployment that wants an administrative override taps the hook with its own policy.

import type { Api } from "@awthaq/api";
import {
  CurrentUser,
  AuthEvents,
  AuthPlugin,
  EmailChange,
  Erasure,
  Errors,
  HookPoint,
  Hooks,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { Password, PasswordCredential } from "@awthaq/password";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as AdminAccountsApi from "./AdminAccountsApi.ts";
import * as AdminApi from "./AdminApi.ts";
import * as AdminEvents from "./AdminEvents.ts";
import * as AdminGate from "./internal/AdminGate.ts";

export interface AdminAccountsShape {
  /**
   * Erases the account through `AccountErasure` (`ErasureInitiator.Admin`), then publishes
   * `auth.admin.userDeleted`. Gate (`canDeleteUsers`) -> self-refusal -> existence. A
   * `BeforeUserDelete` veto surfaces as `HookAborted`, with nothing touched.
   */
  readonly deleteUser: (
    caller: CurrentUser.Caller,
    userId: Users.UserId,
  ) => Effect.Effect<
    void,
    | AdminApi.AdminActionDenied
    | AdminApi.AdminTargetNotFound
    | AdminAccountsApi.AdminSelfActionRefused
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
  /** Mails a change-email confirmation to `email` (gate -> existence -> identity -> conflict -> mail); the address changes when its owner confirms. */
  readonly setUserEmail: (
    caller: CurrentUser.Caller,
    userId: Users.UserId,
    input: { readonly email: string },
  ) => Effect.Effect<
    void,
    | AdminApi.AdminActionDenied
    | AdminApi.AdminTargetNotFound
    | AdminAccountsApi.AdminNoEmailIdentity
    | AdminAccountsApi.AdminEmailAlreadyExists
    | AdminAccountsApi.AdminEmailDeliveryFailed
    | Errors.StoreUnavailable
  >;
  /** Replaces (or creates) the user's password credential and revokes all their sessions. */
  readonly setUserPassword: (
    caller: CurrentUser.Caller,
    userId: Users.UserId,
    input: { readonly password: Redacted.Redacted<string> },
  ) => Effect.Effect<
    void,
    | AdminApi.AdminActionDenied
    | AdminApi.AdminTargetNotFound
    | AdminAccountsApi.AdminSelfActionRefused
    | AdminAccountsApi.AdminNoEmailIdentity
    | AdminAccountsApi.AdminWeakPassword
    | HookPoint.HookAborted
    | Errors.StoreUnavailable
  >;
}

export const AdminAccountsHandlers = HttpApiBuilder.group(
  AdminAccountsApi.AdminAccountsApi,
  "admin.accounts",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* AdminAccounts;
    return handlers.handleAll({
      deleteUser: Effect.fnUntraced(function* ({ params }: { params: AdminApi.UserIdParams }) {
        const caller = yield* CurrentUser.current;
        yield* accounts.deleteUser(caller, Users.UserId(params.userId));
      }),
      setUserEmail: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminAccountsApi.SetUserEmailPayload;
      }) {
        const caller = yield* CurrentUser.current;
        yield* accounts.setUserEmail(caller, Users.UserId(params.userId), payload);
      }),
      setUserPassword: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminAccountsApi.SetUserPasswordPayload;
      }) {
        const caller = yield* CurrentUser.current;
        yield* accounts.setUserPassword(caller, Users.UserId(params.userId), payload);
      }),
    });
  }),
);

/** The request-edge services the handler group names; naming them keeps declaration emit portable (TS2883). */
export type EdgeServices = Api.AdminAuthentication | Api.CsrfProtection | Api.RequestContext;

export class AdminAccounts extends AuthPlugin.Service<AdminAccounts, AdminAccountsShape>()(
  "admin.accounts",
  {
    apiVersion: 1,
    contract: AdminAccountsApi.AdminAccountsApi,
    // ADR-EA-049: the events this plugin publishes, defined in `AdminEvents.ts` beside `Admin`'s.
    events: AdminEvents.accountsEvents,
  },
) {
  static readonly layer = AuthPlugin.layer(AdminAccounts, {
    // ADR-EA-048: the password credential, and its one policy, are `Password`'s.
    dependsOn: [Password.Password],
    ports: [Mailer.Mailer, SqlTransaction.SqlTransaction],
    handlers: AdminAccountsHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const erasure = yield* Erasure.AccountErasure;
      const events = yield* AuthEvents.AuthEvents;
      const credential = yield* PasswordCredential.PasswordCredential;
      const mailer = yield* Mailer.Mailer;
      const random = yield* SecureRandom.SecureRandom;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const gate = yield* AdminGate.make;
      const beforeCredentialReset = yield* Hooks.BeforeCredentialReset;

      const deleteUser: AdminAccountsShape["deleteUser"] = Effect.fnUntraced(
        function* (caller, userId) {
          const cleared = yield* gate.user(caller, "deleteUser", userId);
          if (caller.userId === userId) {
            return yield* Effect.fail(new AdminAccountsApi.AdminSelfActionRefused());
          }
          yield* cleared.target;
          yield* erasure
            .eraseAccount(
              userId,
              Erasure.ErasureInitiator.Admin({ adminUserId: cleared.adminUserId }),
            )
            // Gone between the check and the erasure: the desired end state was reached by someone else.
            .pipe(
              Effect.catchTag("UserNotFound", () =>
                Effect.fail(new AdminApi.AdminTargetNotFound()),
              ),
            );
          yield* events.emit(AdminEvents.AdminUserDeletedEvent, {
            adminUserId: caller.userId,
            userId,
          });
        },
      );

      const setUserEmail: AdminAccountsShape["setUserEmail"] = Effect.fnUntraced(
        function* (caller, userId, input) {
          const cleared = yield* gate.user(caller, "setUserEmail", userId);
          const user = yield* cleared.target;
          const current = Users.emailOf(user);
          if (Option.isNone(current)) {
            return yield* Effect.fail(new AdminAccountsApi.AdminNoEmailIdentity());
          }
          // The address in another case is no change (`Users` stores it lower-cased, BEH-EA-041).
          if (current.value.toLowerCase() === input.email.toLowerCase()) return;
          // An administrator may learn the address is taken (unlike an ordinary user's own request).
          const holder = yield* users.findByEmail(input.email);
          if (Option.isSome(holder)) {
            return yield* Effect.fail(new AdminAccountsApi.AdminEmailAlreadyExists());
          }
          yield* EmailChange.request(
            { verification, random, mailer },
            { userId, newEmail: input.email, link: cleared.config.links.changeEmail },
          ).pipe(
            Effect.catchTag(
              "MailDeliveryFailed",
              () => new AdminAccountsApi.AdminEmailDeliveryFailed(),
            ),
          );
          yield* events.emit(AdminEvents.AdminUserEmailChangeRequestedEvent, {
            adminUserId: caller.userId,
            userId,
          });
        },
      );

      const setUserPassword: AdminAccountsShape["setUserPassword"] = Effect.fnUntraced(
        function* (caller, userId, input) {
          const cleared = yield* gate.user(caller, "setUserPassword", userId);
          if (caller.userId === userId) {
            return yield* Effect.fail(new AdminAccountsApi.AdminSelfActionRefused());
          }
          const user = yield* cleared.target;
          // A password is what an address signs in with: a user with no email identity has nowhere to use one.
          if (Option.isNone(Users.emailOf(user))) {
            return yield* Effect.fail(new AdminAccountsApi.AdminNoEmailIdentity());
          }
          // BEH-EA-120: `Password`'s policy in force for this request's tenant, breach screening
          // included, before the transaction opens (its breach check is a network call).
          const password = yield* credential
            .accept(input.password)
            .pipe(
              Effect.catchTag(
                "WeakPassword",
                (weak) => new AdminAccountsApi.AdminWeakPassword({ hints: weak.hints }),
              ),
            );
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                // ARF-005: the same veto a self-service reset runs, with no second-factor code.
                yield* HookPoint.aborted(Hooks.BeforeCredentialReset)(
                  beforeCredentialReset.run({ userId }),
                );
                // Replaces the credential, or links one for a user who had none.
                yield* credential.set(userId, password);
                // No session issued before this survives the reset — the classic "attacker holds a
                // hijacked session through a password change" gap (impersonation sessions included).
                yield* sessions.revokeAll(userId, "admin");
              }),
            )
            // ADR-EA-028: the transaction's own `SqlError` is an outage (503), never a defect.
            .pipe(
              Effect.catchTag("SqlError", Errors.storeUnavailable("AdminAccounts.setUserPassword")),
            );
          // The credential changed: subscribers of `auth.password.changed` (a notification mail, a
          // SIEM) learn of it as for any change; the admin event names who did it.
          yield* events.publish({ _tag: "auth.password.changed", userId });
          yield* events.emit(AdminEvents.AdminUserPasswordSetEvent, {
            adminUserId: caller.userId,
            userId,
          });
        },
      );

      return AdminAccounts.of({ deleteUser, setUserEmail, setUserPassword });
    }),
  });
}
