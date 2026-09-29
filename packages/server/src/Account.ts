// @awthaq/server — Account
//
// Shipping-gap map (.scratch/shipping-gaps), tickets 09/10. Handlers for
// `@awthaq/api`'s core `account` group, built against `AuthCoreApi`
// the same way `Session.SessionHandlers` is.

import { AuthCore, Api, AccountContract } from "@awthaq/api";
import { Erasure, Users } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { currentUser } from "./internal/CurrentUser.ts";
import { HandlerInvariantViolation } from "./internal/Defects.ts";
import { expireSessionCookie } from "./internal/SessionCookie.ts";

/**
 * The principal an `account` handler runs as. Also keeps `@awthaq/api`'s
 * `Authentication`/`CsrfProtection` middleware nameable for declaration
 * emit — `AccountHandlers`'s inferred type mentions them, and TS2883 fires
 * when this file holds no reference to that module.
 */
export type AccountPrincipal = Api.UserPrincipal;

const toDto = (user: Users.UserRecord): AccountContract.AccountDto =>
  new AccountContract.AccountDto({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
  });

export const AccountHandlers = HttpApiBuilder.group(
  AuthCore.AuthCoreApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const users = yield* Users.Users;
    const erasure = yield* Erasure.AccountErasure;

    return handlers.handleAll({
      updateProfile: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: AccountContract.UpdateProfilePayload;
      }) {
        const { userId } = yield* currentUser;
        // The token was validated at authentication time; the user it
        // names must still exist — a `UserNotFound` here is a defect, not
        // a request-level condition the caller can act on.
        const updated = yield* users.updateProfile(userId, payload).pipe(
          Effect.catchTag("UserNotFound", () =>
            Effect.die(
              new HandlerInvariantViolation({
                invariant: "AuthenticatedUserMissing",
                message: `awthaq: authenticated user missing: ${userId}`,
              }),
            ),
          ),
        );
        return toDto(updated);
      }),

      // Deletes the caller's own account. The cascade itself — every registered
      // plugin's erasure, the core rows (accounts, sessions, verification tokens, the
      // user), the audit pseudonymization, all in one transaction, and the
      // `BeforeUserDelete` veto before any of it — is core's `AccountErasure`
      // (CSG-001/DRS-002, wayfinder ticket 30), so an admin console or a CLI runs the
      // same guaranteed-complete cascade; this handler is only the HTTP edge.
      deleteUser: Effect.fnUntraced(function* () {
        const { userId } = yield* currentUser;
        yield* erasure.eraseAccount(userId, { deletedBy: "self" }).pipe(
          // `@awthaq/api` (the contract stratum) sits below core and cannot name core's
          // `HookAborted`, so the endpoint declares no error for a `BeforeUserDelete` veto
          // (a legal hold): as before this refactor, it surfaces as a server defect.
          Effect.catchTag("HookAborted", Effect.die),
          Effect.catchTag("UserNotFound", () =>
            Effect.die(
              new HandlerInvariantViolation({
                invariant: "AuthenticatedUserMissing",
                message: `awthaq: authenticated user missing: ${userId}`,
              }),
            ),
          ),
        );
        // CSS-002: the account (and this request's own session) is gone, so
        // the browser's now-dead cookie is expired with the response.
        yield* expireSessionCookie;
      }),
    });
  }),
);
