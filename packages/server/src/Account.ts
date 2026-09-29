// @awthaq/server — Account
//
// Shipping-gap map (.scratch/shipping-gaps), tickets 09/10. Handlers for
// `@awthaq/api`'s core `account` group, built against `AuthCoreApi`
// the same way `Session.SessionHandlers` is.

import { AuthCore, Api, AccountContract } from "@awthaq/api";
import { Accounts, Sessions, Users, Verification } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/** FAMS-002: exhaustive over `Users.UserIdentity`; `phone` is an `E164` string on the wire. */
const identityDto = (identity: Users.UserIdentity): AccountContract.IdentityDto => {
  switch (identity._tag) {
    case "Email":
      return { _tag: "Email", email: identity.email, emailVerified: identity.emailVerified };
    case "Phone":
      return { _tag: "Phone", phone: identity.phone, phoneVerified: identity.phoneVerified };
    case "Anonymous":
      return { _tag: "Anonymous" };
  }
};

const toDto = (user: Users.UserRecord): AccountContract.AccountDto =>
  new AccountContract.AccountDto({
    id: user.id,
    identity: identityDto(user.identity),
    name: user.name,
    image: Option.getOrNull(user.image),
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

      // Deletes the caller's own account: the user row, every linked
      // credential (bypassing `unlink`'s last-account refusal — the whole
      // user is going away, so ending up with zero accounts is expected,
      // not a lockout), and every session including the one making this
      // very request (`revokeAll`, not `revokeOthers` plus a sentinel
      // empty `SessionId` standing in for "keep none" — CSG-007/TRBS-008).
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
      // real user at issue time). CSG-001/DRS-002: the rest of
      // plugin-owned PII no longer needs `@awthaq/server` to reach into an
      // optional plugin's own tables directly — `Users.delete` (called
      // below) itself fires the core `Hooks.BeforeUserDelete` veto point
      // (CSG-002), which `@awthaq/passkey`'s and `@awthaq/organization`'s
      // own `.layer` each tap to sweep their own PII (`passkey_credential`,
      // `organization_membership`) inside this same transaction. Still
      // open, deliberately scoped out (see CSG-001's own resolution
      // comment): `organization_team_membership`, `organization_invitation`,
      // and `admin_impersonation` (the last a genuine audit-retention
      // tension, not a mechanical gap).
      deleteUser: Effect.fnUntraced(function* () {
        const { userId } = yield* currentUser;
        yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              yield* accounts.deleteAllByUser(userId);
              // CSG-007/TRBS-008 (.issues/low): `revokeAll` directly, not
              // `revokeOthers` with a sentinel empty `SessionId` standing
              // in for "no session to keep" — that trick predates
              // `revokeAll` existing at all; bundled here since this line
              // was already being rewritten for CSG-001/DRS-002.
              yield* sessions.revokeAll(userId, "userDeleted");
              yield* verification.deleteAllByUser(userId);
              yield* users.delete(userId).pipe(
                Effect.catchTag("UserNotFound", () =>
                  Effect.die(
                    new HandlerInvariantViolation({
                      invariant: "AuthenticatedUserMissing",
                      message: `awthaq: authenticated user missing: ${userId}`,
                    }),
                  ),
                ),
              );
            }),
          )
          // A `SqlError` rolling back the transaction is a defect here,
          // the same way every other unexpected-persistence-failure
          // `.pipe(Effect.orDie)` in this codebase already treats one
          // (see `OAuth.ts`'s identical `SqlTransaction` usage).
          .pipe(Effect.orDie);
        // CSS-002: the account (and this request's own session) is gone, so
        // the browser's now-dead cookie is expired with the response.
        yield* expireSessionCookie;
      }),
    });
  }),
);
