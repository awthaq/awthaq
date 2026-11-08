// @awthaq/server — Session
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-031. Handlers for
// `@awthaq/api`'s core `session` group, built against `AuthCoreApi`
// (BEH-EA-081: a group's handlers are built with `HttpApiBuilder.group`
// against that same group's own contract).

import { AuthCore, Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import { CurrentUser, Sessions } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { expireSessionCookie } from "./internal/SessionCookie.ts";
import { toSessionDto as mapSessionDto } from "./internal/SessionDto.ts";
import * as SessionDelivery from "./SessionDelivery.ts";

/** RSC-005: the one `SessionView` -> `SessionDto` mapper (`@awthaq/next`'s `toInitialSession` uses it too). */
export const toSessionDto = mapSessionDto;

const toDto = (item: Sessions.SessionListItem): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: item.id,
    createdAt: item.createdAt,
    lastActiveAt: item.lastActiveAt,
    expiresAt: item.expiresAt,
    userAgent: Option.getOrNull(item.userAgent),
    amr: item.amr,
    current: item.current,
  });

/**
 * `Sessions.Sessions` is an ordinary ambient domain service, safe to
 * resolve once here — in the group-builder generator itself, which runs
 * once at `Layer`-build time — and close over from every handler below,
 * the same way `@effect/platform`'s own `HttpApiBuilder.group` examples
 * resolve a domain service once and reuse it per handler. Only
 * `Api.CurrentPrincipal` (genuinely different per request) is read inside
 * each individual handler, through `CurrentUser.current` (GC-003).
 */
export const SessionHandlers = HttpApiBuilder.group(
  AuthCore.AuthCoreApi,
  "session",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions.Sessions;

    return handlers.handleAll({
      current: Effect.fnUntraced(function* () {
        const { userId, sessionId } = yield* CurrentUser.current;
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
        const { userId, sessionId } = yield* CurrentUser.current;
        // RRC-001: a display-only listing — the one session read a replica may serve.
        const items = yield* sessions.list(userId, sessionId, { consistency: "eventual" });
        return items.map(toDto);
      }),

      // Idempotent by design: if the session is already gone (e.g. revoked
      // from another tab a moment earlier), the caller's goal — "this
      // session is no longer valid" — is already true, so a concurrent
      // `SessionNotFound` here is swallowed rather than surfaced as an error.
      // CSS-002/ADR-EA-045: the caller's own session ended (`SessionLifecycle.Ends`): its cookie is expired
      // and a bearer client is told so.
      signOut: Effect.fnUntraced(function* () {
        const { sessionId } = yield* CurrentUser.current;
        yield* sessions
          .revoke(sessionId, "signOut")
          .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.void));
        yield* SessionDelivery.end;
      }),

      // BEH-EA-086/ADR-EA-013: a foreign or unknown target id answers
      // identically — `SessionNotFound` — so this endpoint cannot be used
      // to enumerate another account's live sessions.
      revoke: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: SessionContract.RevokePayload;
      }) {
        const { userId, sessionId } = yield* CurrentUser.current;
        // The one wire-to-domain re-brand in this package (GC-003): the
        // payload id is untrusted input, not a verified session's own id.
        const targetId = Sessions.SessionId(payload.id);
        // GC-005: ownership is enforced atomically by the domain operation
        // (no list-then-check, no 200-row cap); a foreign id and an unknown
        // id are indistinguishable.
        yield* sessions
          .revokeOwned(userId, targetId, targetId === sessionId ? "signOut" : "userRevoked")
          .pipe(Effect.catchTag("Sessions/NotFound", () => new SessionContract.SessionNotFound()));
        // CSS-002: revoking one's own current session ends it too; revoking a
        // different device's session leaves this credential alone (the declaration is declined).
        if (targetId === sessionId) yield* SessionDelivery.end;
        else yield* SessionDelivery.decline(SessionLifecycle.EndGrant);
      }),

      revokeOthers: Effect.fnUntraced(function* () {
        const { userId, sessionId } = yield* CurrentUser.current;
        yield* sessions.revokeOthers(userId, sessionId, "userRevoked");
      }),

      // Ticket 02: truly all, no exceptions — kills the caller's own
      // current session too, as a natural consequence of "all" meaning all;
      // CSS-002: so its cookie is expired as well.
      revokeAll: Effect.fnUntraced(function* () {
        const { userId } = yield* CurrentUser.current;
        yield* sessions.revokeAll(userId, "userRevoked");
        yield* SessionDelivery.end;
      }),
    });
  }),
);
