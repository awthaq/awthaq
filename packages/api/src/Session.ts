// @effect-auth/api — Session
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-031.
//
// Core's own `session` `HttpApiGroup` — reserved, root-level ids
// (`current`/`list`/`signOut`/`revoke`/`revokeOthers`), needing no plugin
// to exist at all. Not yet folded into `Auth.make`'s composed `api`
// (`Auth.ts`'s own header comment tracks that as separate, later work);
// this is the standalone contract, wired to real handlers in
// `@effect-auth/server/src/Session.ts`.

import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Authentication } from "./Api.ts";

/** One row of `list` — the wire shape of `@effect-auth/core`'s `SessionListItem`. */
export class SessionDto extends Schema.Class<SessionDto>("SessionDto")({
  id: Schema.String,
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  expiresAt: Schema.String,
  userAgent: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
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
  .add(HttpApiEndpoint.get("current", "/session", { success: SessionDto }))
  .add(HttpApiEndpoint.get("list", "/session/list", { success: Schema.Array(SessionDto) }))
  .add(HttpApiEndpoint.post("signOut", "/session/sign-out"))
  .add(
    HttpApiEndpoint.post("revoke", "/session/revoke", {
      payload: RevokePayload,
      error: SessionNotFound,
    }),
  )
  .add(HttpApiEndpoint.post("revokeOthers", "/session/revoke-others"))
  .middleware(Authentication);
