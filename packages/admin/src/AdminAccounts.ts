// @awthaq/admin — AdminAccounts
//
// BAM-005/BAM-009 (BEH-EA-221, BEH-EA-225): deleting a user, setting a user's email and setting a
// user's password, as an opt-in plugin beside `Admin`: `Auth.make([Admin, AdminAccounts])`.
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
// - `setUserPassword` writes the hash through the `PasswordHasher` port (never a hash of this
//   package's own), replaces the credential — or creates the password credential if the user had
//   none — and revokes every session of the user (reason `admin`) in the same transaction, so a
//   session an attacker held does not survive the reset. It consults `Hooks.BeforeCredentialReset`
//   (ARF-005) with no second-factor code, exactly like a self-service reset that has none: for a
//   user protected by a second factor the veto refuses (`HookAborted`, code `TWO_FACTOR_REQUIRED`)
//   and nothing is written. An administrator cannot supply the user's factor, so the safe default
//   is that an admin cannot silently replace the password of an MFA-protected account; a
//   deployment that wants an administrative override taps the hook with its own policy.

import { Api } from "@awthaq/api";
import {
  Accounts,
  AuthEvents,
  AuthPlugin,
  Defects,
  EmailChange,
  Erasure,
  Errors,
  HookPoint,
  Hooks,
  Sessions,
  Tenant,
  Users,
  Verification,
} from "@awthaq/core";
import { Mailer, PasswordHasher, SqlTransaction } from "@awthaq/ports";
import { makeSubject } from "@qadi/core";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { AdminConfig } from "./Admin.ts";
import * as AdminAccountsApi from "./AdminAccountsApi.ts";
import * as AdminApi from "./AdminApi.ts";

export interface AdminAccountsShape {
  /**
   * Erases the account through `AccountErasure` (`deletedBy: "admin"`), then publishes
   * `auth.admin.userDeleted`. Gate (`canDeleteUsers`) -> self-refusal -> existence. A
   * `BeforeUserDelete` veto surfaces as `HookAborted`, with nothing touched.
   */
  readonly deleteUser: (
    caller: Api.UserPrincipal,
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
    caller: Api.UserPrincipal,
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
    caller: Api.UserPrincipal,
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

const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: admin.accounts group reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

export const AdminAccountsHandlers = HttpApiBuilder.group(
  AdminAccountsApi.AdminAccountsApi,
  "admin.accounts",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* AdminAccounts;
    return handlers.handleAll({
      deleteUser: Effect.fnUntraced(function* ({ params }: { params: AdminApi.UserIdParams }) {
        const caller = yield* currentUserPrincipal;
        yield* accounts.deleteUser(caller, Users.UserId(params.userId));
      }),
      setUserEmail: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminAccountsApi.SetUserEmailPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* accounts.setUserEmail(caller, Users.UserId(params.userId), payload);
      }),
      setUserPassword: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminAccountsApi.SetUserPasswordPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* accounts.setUserPassword(caller, Users.UserId(params.userId), payload);
      }),
    });
  }),
);

export class AdminAccounts extends AuthPlugin.Service<AdminAccounts, AdminAccountsShape>()(
  "admin.accounts",
  {
    apiVersion: 1,
    contract: AdminAccountsApi.AdminAccountsApi,
  },
) {
  static readonly layer = AuthPlugin.layer(AdminAccounts, {
    handlers: AdminAccountsHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const accountStore = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const erasure = yield* Erasure.AccountErasure;
      const events = yield* AuthEvents.AuthEvents;
      const hasher = yield* PasswordHasher.PasswordHasher;
      const mailer = yield* Mailer.Mailer;
      const crypto = yield* Crypto.Crypto;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const adminConfig = yield* AdminConfig;
      const beforeCredentialReset = yield* Hooks.BeforeCredentialReset;

      /** Gate first (a denied caller learns nothing about ids or refusal rules), same event as `Admin`'s user gates. */
      const authorize = Effect.fnUntraced(function* (
        caller: Api.UserPrincipal,
        action: string,
        userId: Users.UserId,
        gate: "canDeleteUsers" | "canManageCredentials",
      ) {
        const allowed = yield* adminConfig[gate]({
          admin: makeSubject({ id: caller.ref.id }),
          target: Option.some(makeSubject({ id: userId })),
          tenantId: yield* Tenant.TenantContext,
        });
        if (!allowed) {
          yield* events.publish({
            _tag: "auth.admin.actionDenied",
            adminUserId: Users.UserId(caller.ref.id),
            action,
          });
          return yield* Effect.fail(new AdminApi.AdminActionDenied());
        }
      });

      const existing = (userId: Users.UserId) =>
        users
          .findById(userId)
          .pipe(
            Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())),
          );

      const deleteUser: AdminAccountsShape["deleteUser"] = Effect.fnUntraced(
        function* (caller, userId) {
          yield* authorize(caller, "deleteUser", userId, "canDeleteUsers");
          if (caller.ref.id === userId) {
            return yield* Effect.fail(new AdminAccountsApi.AdminSelfActionRefused());
          }
          yield* existing(userId);
          yield* erasure
            .eraseAccount(userId, { deletedBy: "admin" })
            // Gone between the check and the erasure: the desired end state was reached by someone else.
            .pipe(
              Effect.catchTag("UserNotFound", () =>
                Effect.fail(new AdminApi.AdminTargetNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.admin.userDeleted",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
          });
        },
      );

      const setUserEmail: AdminAccountsShape["setUserEmail"] = Effect.fnUntraced(
        function* (caller, userId, input) {
          yield* authorize(caller, "setUserEmail", userId, "canManageCredentials");
          const user = yield* existing(userId);
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
            { verification, crypto, mailer },
            { userId, newEmail: input.email, link: adminConfig.links.changeEmail },
          ).pipe(
            Effect.catchTag(
              "MailDeliveryFailed",
              () => new AdminAccountsApi.AdminEmailDeliveryFailed(),
            ),
          );
          yield* events.publish({
            _tag: "auth.admin.userEmailChangeRequested",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
          });
        },
      );

      const setUserPassword: AdminAccountsShape["setUserPassword"] = Effect.fnUntraced(
        function* (caller, userId, input) {
          yield* authorize(caller, "setUserPassword", userId, "canManageCredentials");
          if (caller.ref.id === userId) {
            return yield* Effect.fail(new AdminAccountsApi.AdminSelfActionRefused());
          }
          const user = yield* existing(userId);
          // A password is what an address signs in with: a user with no email identity has nowhere to use one.
          if (Option.isNone(Users.emailOf(user))) {
            return yield* Effect.fail(new AdminAccountsApi.AdminNoEmailIdentity());
          }
          const hints = yield* adminConfig.passwordPolicy(input.password);
          if (hints.length > 0) {
            return yield* Effect.fail(new AdminAccountsApi.AdminWeakPassword({ hints }));
          }
          // The expensive hash is computed before the transaction opens.
          const hash = Redacted.make(yield* hasher.hash(input.password));
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                // ARF-005: the same veto a self-service reset runs, with no second-factor code.
                yield* HookPoint.aborted(Hooks.BeforeCredentialReset)(
                  beforeCredentialReset.run({ userId }),
                );
                const account = yield* accountStore.findByProviderSubject(
                  Accounts.PASSWORD_PROVIDER_ID,
                  userId,
                );
                if (Option.isSome(account)) {
                  yield* accountStore
                    .updateCredentialHash(account.value.id, hash)
                    .pipe(
                      Effect.catchTag("AccountNotFound", () =>
                        Effect.fail(new AdminApi.AdminTargetNotFound()),
                      ),
                    );
                } else {
                  yield* accountStore
                    .link({
                      userId,
                      providerId: Accounts.PASSWORD_PROVIDER_ID,
                      subject: userId,
                      credentialHash: hash,
                    })
                    // `findByProviderSubject` above just said there is none: a racing link is a defect here.
                    .pipe(Effect.catchTag("AccountAlreadyLinked", Effect.die));
                }
                // No session issued before this survives the reset — the classic "attacker holds a
                // hijacked session through a password change" gap (impersonation sessions included).
                yield* sessions.revokeAll(userId, "admin");
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
          // The credential changed: subscribers of `auth.password.changed` (a notification mail, a
          // SIEM) learn of it as for any change; the admin event names who did it.
          yield* events.publish({ _tag: "auth.password.changed", userId });
          yield* events.publish({
            _tag: "auth.admin.userPasswordSet",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
          });
        },
      );

      return AdminAccounts.of({ deleteUser, setUserEmail, setUserPassword });
    }),
  });
}
