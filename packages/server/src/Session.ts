// @awthaq/server — Session
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-031. Handlers for
// `@awthaq/api`'s core `session` group, built against `AuthCoreApi`
// (BEH-EA-081: a group's handlers are built with `HttpApiBuilder.group`
// against that same group's own contract).

import { AuthCore, Api, SessionContract } from "@awthaq/api";
import { Sessions } from "@awthaq/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { currentUser } from "./internal/CurrentUser.ts";
import { expireSessionCookie } from "./internal/SessionCookie.ts";

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
 * `Sessions.Sessions` is an ordinary ambient domain service, safe to
 * resolve once here — in the group-builder generator itself, which runs
 * once at `Layer`-build time — and close over from every handler below,
 * the same way `@effect/platform`'s own `HttpApiBuilder.group` examples
 * resolve a domain service once and reuse it per handler. Only
 * `Api.CurrentPrincipal` (genuinely different per request) is read inside
 * each individual handler, through `currentUser` (GC-003).
 */
export const SessionHandlers = HttpApiBuilder.group(
  AuthCore.AuthCoreApi,
  "session",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions.Sessions;

    return handlers.handleAll({
      current: Effect.fnUntraced(function* () {
        const { userId, sessionId } = yield* currentUser;
        // TIR-003/ESS-005: a keyed lookup, never `list` + `find` — a user
        // with many historical sessions used to push the current one off the
        // list's first page and turn this into a 500.
        const item = yield* sessions.findOwned(userId, sessionId);
        if (Option.isNone(item)) {
          // EHA-009: the session was revoked (or expired) between the
          // middleware's verify and this read — a concurrent revoke, not a
          // server fault. Answer what the caller needs to act on: a typed
          // 401 and an expired cookie, so its session atom clears.
          yield* expireSessionCookie;
          return yield* Effect.fail(new Api.Unauthenticated());
        }
        return toDto({ ...item.value, current: true });
      }),

      list: Effect.fnUntraced(function* () {
        const { userId, sessionId } = yield* currentUser;
        const items = yield* sessions.list(userId, sessionId);
        return items.map(toDto);
      }),

      // Idempotent by design: if the session is already gone (e.g. revoked
      // from another tab a moment earlier), the caller's goal — "this
      // session is no longer valid" — is already true, so a concurrent
      // `SessionNotFound` here is swallowed rather than surfaced as an error.
      // CSS-002: the caller's own session ended, so its cookie is expired.
      signOut: Effect.fnUntraced(function* () {
        const { sessionId } = yield* currentUser;
        yield* sessions
          .revoke(sessionId, "signOut")
          .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
        yield* expireSessionCookie;
      }),

      // BEH-EA-086/ADR-EA-013: a foreign or unknown target id answers
      // identically — `SessionNotFound` — so this endpoint cannot be used
      // to enumerate another account's live sessions.
      revoke: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: SessionContract.RevokePayload;
      }) {
        const { userId, sessionId } = yield* currentUser;
        // The one wire-to-domain re-brand in this package (GC-003): the
        // payload id is untrusted input, not a verified session's own id.
        const targetId = Sessions.SessionId(payload.id);
        // GC-005: ownership is enforced atomically by the domain operation
        // (no list-then-check, no 200-row cap); a foreign id and an unknown
        // id are indistinguishable.
        yield* sessions
          .revokeOwned(userId, targetId, targetId === sessionId ? "signOut" : "userRevoked")
          .pipe(Effect.catchTag("SessionNotFound", () => new SessionContract.SessionNotFound()));
        // CSS-002: revoking one's own current session ends it too; revoking a
        // different device's session leaves this cookie alone.
        if (targetId === sessionId) yield* expireSessionCookie;
      }),

      revokeOthers: Effect.fnUntraced(function* () {
        const { userId, sessionId } = yield* currentUser;
        yield* sessions.revokeOthers(userId, sessionId, "userRevoked");
      }),

      // Ticket 02: truly all, no exceptions — kills the caller's own
      // current session too, as a natural consequence of "all" meaning all;
      // CSS-002: so its cookie is expired as well.
      revokeAll: Effect.fnUntraced(function* () {
        const { userId } = yield* currentUser;
        yield* sessions.revokeAll(userId, "userRevoked");
        yield* expireSessionCookie;
      }),
    });
  }),
);
