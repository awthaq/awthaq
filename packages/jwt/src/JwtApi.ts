// @awthaq/jwt — JwtApi
//
// .scratch/jwt/issues/09-jwks-endpoint.md, 10-explicit-mint-endpoint.md.
// Path convention corrected from the tickets' own loose "`/auth/jwt/...`"
// phrasing (copied from `spec/models/08-jwt-bearer.md`'s own non-normative
// sketch comment) to match every other plugin's real, established
// convention — `/<pluginId>/...`, never `/auth/<pluginId>/...` (see
// `AdminApi.ts`'s `/admin/...`, `OrganizationApi.ts`'s `/organization/...`,
// `PasswordApi.ts`'s `/password/...`): the top-level `HttpApi.make("auth")`
// identifier names the composed API, not a URL prefix.
//
// Two groups, not one — `jwks` is public (JWKS is public by definition),
// `token` requires an authenticated caller. This codebase's own established
// pattern for a plugin mixing public and authenticated endpoints is a
// second, dotted-sub-id group carrying its own `.middleware(Api.Authentication)`
// (see `PasskeyApi.ts`'s `passkey`/`passkey.authenticate` split), never a
// per-endpoint middleware inside one shared group.

import { Api } from "@awthaq/api";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

const JwkSchema = Schema.Record(Schema.String, Schema.Unknown);

/** A standard JWKS document — public key material only, never private. */
export class JwksResponse extends Schema.Class<JwksResponse>("JwksResponse")({
  keys: Schema.Array(JwkSchema),
}) {}

/** The mint endpoint's own response — no request payload accepted, so no request schema exists at all. */
export class TokenResponse extends Schema.Class<TokenResponse>("TokenResponse")({
  token: Schema.String,
}) {}

/** TIR-001/TRBS-001/MAPS-002: the `/jwt/introspect` request — any bearer-shaped string, not necessarily one this issuer minted. */
export class IntrospectRequest extends Schema.Class<IntrospectRequest>("IntrospectRequest")({
  token: Schema.String,
}) {}

/**
 * RFC 7662 shape, narrowed to this codebase's own claims: `claims` is
 * present exactly when `active` is `true` — every failure mode (bad
 * signature, expired, denylisted, dead session) collapses to
 * `{ active: false }` alone, matching `JwtCodec`'s own undifferentiated
 * `JwtInvalidError` and `Verification.ts`'s own uniform-response posture.
 */
export class IntrospectionResponse extends Schema.Class<IntrospectionResponse>(
  "IntrospectionResponse",
)({
  active: Schema.Boolean,
  claims: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export const JwtGroup = HttpApiGroup.make("jwt").add(
  HttpApiEndpoint.get("jwks", "/jwt/jwks", {
    success: JwksResponse,
  }),
);

export const JwtTokenGroup = HttpApiGroup.make("jwt.token")
  .add(
    HttpApiEndpoint.get("mint", "/jwt/token", {
      success: TokenResponse,
    }),
  )
  .add(
    // Gated by `Api.Authentication` exactly like `mint` above — no new
    // trust model invented for this endpoint (ticket 11's own decision).
    HttpApiEndpoint.post("introspect", "/jwt/introspect", {
      payload: IntrospectRequest,
      success: IntrospectionResponse,
    }),
  )
  .middleware(Api.Authentication);

export const JwtApi = HttpApi.make("auth").add(JwtGroup).add(JwtTokenGroup);
