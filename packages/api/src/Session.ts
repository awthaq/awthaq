// @awthaq/api — Session
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-031.
//
// Core's own `session` `HttpApiGroup` — reserved, root-level ids
// (`current`/`list`/`signOut`/`revoke`/`revokeOthers`), needing no plugin
// to exist at all. Not yet folded into `Auth.make`'s composed `api`
// (`Auth.ts`'s own header comment tracks that as separate, later work);
// this is the standalone contract, wired to real handlers in
// `@awthaq/server/src/Session.ts`.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Authentication, CsrfProtection, Unauthenticated } from "./Api.ts";

/** One row of `list` — the wire shape of `@awthaq/core`'s `SessionListItem`. */
export class SessionDto extends Schema.Class<SessionDto>("SessionDto")({
  id: Schema.String,
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  expiresAt: Schema.String,
  userAgent: Schema.NullOr(Schema.String),
  /**
   * THS-003: RFC 8176 `amr` — how this session was authenticated (`pwd`,
   * `hwk`, `fed`, ...). Defaults to none — at construction, and when decoding a
   * payload from a server that predates it — the shipped handlers always set it.
   */
  amr: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
  ),
  current: Schema.Boolean,
  /**
   * MNA-001 (ticket 17): the raw session token, present only when the request
   * opted in with `X-Awthaq-Token-Delivery: bearer` (and then no cookie is set).
   * Never populated for a browser request, so the token stays out of JS-readable
   * bodies there.
   */
  token: Schema.optional(Schema.String),
}) {}

/**
 * BEH-EA-086/ADR-EA-013: a session a caller does not own maps to the same
 * "no such session" error a genuinely unknown id would — never a
 * distinguishable `Forbidden`, so `revoke` cannot be used to enumerate
 * another account's live sessions.
 */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export const RevokePayload = Schema.Struct({ id: Schema.String });
export type RevokePayload = typeof RevokePayload.Type;

export const SessionGroup = HttpApiGroup.make("session")
  // EHA-009: a session revoked between the middleware's verify and the
  // handler's read answers a typed 401 (with an expired cookie), not a 500.
  .add(HttpApiEndpoint.get("current", "/session", { success: SessionDto, error: Unauthenticated }))
  .add(HttpApiEndpoint.get("list", "/session/list", { success: Schema.Array(SessionDto) }))
  .add(HttpApiEndpoint.post("signOut", "/session/sign-out"))
  .add(
    HttpApiEndpoint.post("revoke", "/session/revoke", {
      payload: RevokePayload,
      error: SessionNotFound,
    }),
  )
  .add(HttpApiEndpoint.post("revokeOthers", "/session/revoke-others"))
  // Upstream-hardening map, ticket 02: completes the `revoke`/
  // `revokeOthers`/`revokeAll` naming symmetry — kills every session for
  // the caller, no exceptions, including the caller's own current
  // session. No payload. CSS-002: like `signOut`, the response expires the
  // `__Host-session` cookie (`@awthaq/server`'s handlers do this).
  .add(HttpApiEndpoint.post("revokeAll", "/session/revoke-all"))
  // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `CsrfProtection`
  // declared last (outermost, runs first — see `AuthorizedSubject.ts`'s
  // header on declaration order) so a forged request is rejected before
  // `Authentication` does any credential work.
  .middleware(Authentication)
  .middleware(CsrfProtection);
