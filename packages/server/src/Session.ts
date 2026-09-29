// @awthaq/server — Session
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-031. Handlers for
// `@awthaq/api`'s core `session` group, built against `AuthCoreApi`
// (BEH-EA-081: a group's handlers are built with `HttpApiBuilder.group`
// against that same group's own contract).

import { AuthCore, Api, SessionContract } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

/**
 * RSC-005: the one `SessionView` -> `SessionDto` mapper. The password/admin/
 * passkey handlers used to each keep a private identical copy, and
 * `@awthaq/next`'s `toInitialSession` needs the same mapping to seed
 * `@awthaq/react`'s `Providers`. `current` defaults to `true` — the view a
 * sign-in/sign-up/`getSession` returns is, by construction, the caller's own.
 */
export const toSessionDto = (
  view: Sessions.SessionView,
  current = true,
): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: view.id,
    createdAt: DateTime.formatIso(view.createdAt),
    lastActiveAt: DateTime.formatIso(view.lastActiveAt),
    expiresAt: DateTime.formatIso(view.absoluteExpiresAt),
    userAgent: Option.getOrNull(view.userAgent),
    current,
  });

const toDto = (item: Sessions.SessionListItem): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: item.id,
    createdAt: DateTime.formatIso(item.createdAt),
    lastActiveAt: DateTime.formatIso(item.lastActiveAt),
    expiresAt: DateTime.formatIso(item.expiresAt),
    userAgent: Option.getOrNull(item.userAgent),
    current: item.current,
  });

/**
 * `Authentication` (required, not `OptionalAuthentication`) already refuses
 * the request with `Unauthenticated` before a handler ever runs, so
 * `CurrentPrincipal` here is never `Anonymous` in practice; a principal
 * kind with no `sessionId` (`ApiKey`/`Service`) reaching this group at all
 * is a wiring defect this pass doesn't need to recover from, not a
 * request-level condition a caller can act on.
 */
const currentUserPrincipal: Effect.Effect<Api.UserPrincipal, never, Api.CurrentPrincipal> =
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    if (principal._tag !== "User") {
      return yield* Effect.die(
        new Error(`awthaq: session group reached with a non-User principal: ${principal._tag}`),
      );
    }
    return principal;
  });

/**
 * `Sessions.Sessions` is an ordinary ambient domain service, safe to
 * resolve once here — in the group-builder generator itself, which runs
 * once at `Layer`-build time — and close over from every handler below,
 * the same way `@effect/platform`'s own `HttpApiBuilder.group` examples
 * resolve a domain service once and reuse it per handler. Only
 * `Api.CurrentPrincipal` (genuinely different per request) is read inside
 * each individual handler.
 */
export const SessionHandlers = HttpApiBuilder.group(
  AuthCore.AuthCoreApi,
  "session",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions.Sessions;

    return handlers.handleAll({
      current: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        const sessionId = Sessions.SessionId(principal.sessionId);
        const items = yield* sessions.list(userId, sessionId);
        const item = items.find((row) => row.current);
        if (item === undefined) {
          return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
        }
        return toDto(item);
      }),

      list: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        const sessionId = Sessions.SessionId(principal.sessionId);
        const items = yield* sessions.list(userId, sessionId);
        return items.map(toDto);
      }),

      // Idempotent by design: if the session is already gone (e.g. revoked
      // from another tab a moment earlier), the caller's goal — "this
      // session is no longer valid" — is already true, so a concurrent
      // `SessionNotFound` here is swallowed rather than surfaced as an error.
      signOut: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        yield* sessions
          .revoke(Sessions.SessionId(principal.sessionId))
          .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
      }),

      // BEH-EA-086/ADR-EA-013: a foreign or unknown target id answers
      // identically — `SessionNotFound` — so this endpoint cannot be used
      // to enumerate another account's live sessions.
      revoke: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: SessionContract.RevokePayload;
      }) {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        const targetId = Sessions.SessionId(payload.id);
        const owned = yield* sessions.list(userId);
        if (!owned.some((row) => row.id === targetId)) {
          return yield* Effect.fail(new SessionContract.SessionNotFound());
        }
        yield* sessions
          .revoke(targetId)
          .pipe(Effect.catchTag("SessionNotFound", () => new SessionContract.SessionNotFound()));
      }),

      revokeOthers: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        const sessionId = Sessions.SessionId(principal.sessionId);
        yield* sessions.revokeOthers(userId, sessionId);
      }),

      // Ticket 02: truly all, no exceptions — kills the caller's own
      // current session too, as a natural consequence of "all" meaning all.
      revokeAll: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        const userId = Users.UserId(principal.ref.id);
        yield* sessions.revokeAll(userId);
      }),
    });
  }),
);
