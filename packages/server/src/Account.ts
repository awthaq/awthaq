// @awthaq/server — Account
//
// Shipping-gap map (.scratch/shipping-gaps), tickets 09/10. Handlers for
// `@awthaq/api`'s core `account` group, built against `AuthCoreApi`
// the same way `Session.SessionHandlers` is.

import { AuthCore, Api, AccountContract } from "@awthaq/api";
import { Accounts, Sessions, Users } from "@awthaq/core";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/**
 * Mirrors `Session.ts`'s own `currentUserPrincipal` exactly — `Account`
 * carries the same `Authentication` middleware, so the same invariant
 * (a non-`User` principal reaching a required-auth group is a wiring
 * defect, not a request-level condition) applies here too.
 */
const currentUserPrincipal: Effect.Effect<Api.UserPrincipal, never, Api.CurrentPrincipal> =
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    if (principal._tag !== "User") {
      return yield* Effect.die(
        new Error(`awthaq: account group reached with a non-User principal: ${principal._tag}`),
      );
    }
    return principal;
  });

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
    const accounts = yield* Accounts.Accounts;
    const sessions = yield* Sessions.Sessions;

    return handlers.handleAll({
      updateProfile: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: AccountContract.UpdateProfilePayload;
      }) {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        // The token was validated at authentication time; the user it
        // names must still exist — a `UserNotFound` here is a defect, not
        // a request-level condition the caller can act on.
        const updated = yield* users
          .updateProfile(userId, payload)
          .pipe(
            Effect.catchTag("UserNotFound", () =>
              Effect.die(new Error(`awthaq: authenticated user missing: ${userId}`)),
            ),
          );
        return toDto(updated);
      }),

      // Deletes the caller's own account: the user row, every linked
      // credential (bypassing `unlink`'s last-account refusal — the whole
      // user is going away, so ending up with zero accounts is expected,
      // not a lockout), and every session including the one making this
      // very request (the sentinel empty `SessionId` mirrors `Password`'s
      // own `confirmReset` trick: no real session can ever have that id,
      // so `revokeOthers` with it revokes all of them).
      deleteUser: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        yield* accounts.deleteAllByUser(userId);
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
        yield* users
          .delete(userId)
          .pipe(
            Effect.catchTag("UserNotFound", () =>
              Effect.die(new Error(`awthaq: authenticated user missing: ${userId}`)),
            ),
          );
      }),
    });
  }),
);
