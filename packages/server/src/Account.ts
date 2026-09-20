// @awthaq/server — Account
//
// Shipping-gap map (.scratch/shipping-gaps), tickets 09/10. Handlers for
// `@awthaq/api`'s core `account` group, built against `AuthCoreApi`
// the same way `Session.SessionHandlers` is.

import { AuthCore, Api, AccountContract } from "@awthaq/api";
import { Accounts, Sessions, Users, Verification } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

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
    const verification = yield* Verification.Verification;
    const sqlTransaction = yield* SqlTransaction.SqlTransaction;

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
      //
      // CSG-001/DRS-002: the three-call cascade now runs inside one
      // `SqlTransaction` — a failure partway through used to strand the
      // user with, e.g., accounts deleted but the row itself still live,
      // an unrecoverable partial-erasure state no retry can distinguish
      // from a fresh delete request. `layerNoop` (an in-memory
      // composition, where every write already lands atomically in its
      // own `Ref.modify`) makes this a no-op wrapper there, same as every
      // other `SqlTransaction` consumer in this codebase.
      //
      // BCR-003 (.issues/high): `verification.deleteAllByUser` closes this
      // cascade's own verification-token gap — see `Verification.ts`'s own
      // `userId` column comment for why not every row is reachable this
      // way (a not-yet-authenticated OAuth flow's own state token has no
      // real user at issue time). Still open (tracked separately, not this
      // fix's scope): the rest of plugin-owned PII — passkey credentials,
      // organization membership/invitations, admin impersonation records —
      // is not erased by this cascade. `@awthaq/server` cannot reach into
      // an optional plugin's own tables without a real dependency-inversion
      // mechanism (a cross-plugin hook point), and this repo's own
      // `HookPoint` module documents that concrete hook points are not yet
      // wired into any real flow — see that module's own header and
      // `Auth.ts`'s header on `AuthCore` not yet existing. Passkey's own
      // authenticateVerify closes the concrete, exploitable consequence
      // of this gap independently (WPS-001: a surviving credential can no
      // longer mint a session for a deleted user, checked at
      // authentication time rather than relying on erasure completeness).
      deleteUser: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              yield* accounts.deleteAllByUser(userId);
              yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
              yield* verification.deleteAllByUser(userId);
              yield* users
                .delete(userId)
                .pipe(
                  Effect.catchTag("UserNotFound", () =>
                    Effect.die(new Error(`awthaq: authenticated user missing: ${userId}`)),
                  ),
                );
            }),
          )
          // A `SqlError` rolling back the transaction is a defect here,
          // the same way every other unexpected-persistence-failure
          // `.pipe(Effect.orDie)` in this codebase already treats one
          // (see `OAuth.ts`'s identical `SqlTransaction` usage).
          .pipe(Effect.orDie);
      }),
    });
  }),
);
