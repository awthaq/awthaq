// @awthaq/api-key — ApiKeyApi
//
// spec/models/07-api-keys.md, BEH-EA-140/141, ADR-EA-022. The plugin's contract, three
// groups under the shared "auth" id (BEH-EA-004):
//
// - `apiKey` — a signed-in user's own long-lived keys (create/list/revoke/rotate);
// - `apiKey.client` — that user's `client_credentials` clients (register/list/revoke/
//   rotate the secret);
// - `apiKey.token` — the RFC 6749 §4.4 token endpoint. Anonymous by design and with no
//   CSRF check: it is a back-channel POST whose only authorization is the client secret
//   in the request, and a browser never calls it.
//
// Both management groups sit behind `Authentication` (the *user* tier): an API key or a
// service token cannot mint or rotate credentials, only a session can.

import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

// ---- errors (management surface) -----------------------------------------------

/**
 * BEH-EA-086/ADR-EA-013: an unknown key and one that belongs to someone else are the
 * same 404, so `revoke`/`rotate` cannot be used to probe other users' key ids.
 */
export class ApiKeyNotFound extends Schema.TaggedError<ApiKeyNotFound>()(
  "ApiKeyNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The client-side twin of `ApiKeyNotFound`. */
export class ApiKeyClientNotFound extends Schema.TaggedError<ApiKeyClientNotFound>()(
  "ApiKeyClientNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** `ApiKeyConfig.grantableScopes` does not include every requested scope; `scopes` lists the refused ones. */
export class ApiKeyScopeNotGrantable extends Schema.TaggedError<ApiKeyScopeNotGrantable>()(
  "ApiKeyScopeNotGrantable",
  { scopes: Schema.Array(Schema.String) },
  { httpApiStatus: 422 },
) {}

/** A requested expiry or rotation grace period is outside what `ApiKeyConfig` allows. */
export class ApiKeyLifetimeInvalid extends Schema.TaggedError<ApiKeyLifetimeInvalid>()(
  "ApiKeyLifetimeInvalid",
  {},
  { httpApiStatus: 422 },
) {}

// ---- errors (token endpoint, RFC 6749 §5.2) --------------------------------------
//
// The body carries the RFC's `error` member (alongside the typed `_tag`), so a stock
// OAuth2 client library reads it without knowing this contract.

const rfcError = <const Code extends string>(code: Code) =>
  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)));

/** Unknown client, wrong secret, revoked client or a malformed `Authorization: Basic`: all one answer (401). */
export class InvalidClient extends Schema.TaggedError<InvalidClient>()(
  "InvalidClient",
  { error: rfcError("invalid_client") },
  { httpApiStatus: 401 },
) {}

/** Requested scopes share nothing with the client's registered scopes. */
export class InvalidScope extends Schema.TaggedError<InvalidScope>()(
  "InvalidScope",
  { error: rfcError("invalid_scope") },
  { httpApiStatus: 400 },
) {}

/** Only `grant_type=client_credentials` is implemented. */
export class UnsupportedGrantType extends Schema.TaggedError<UnsupportedGrantType>()(
  "UnsupportedGrantType",
  { error: rfcError("unsupported_grant_type") },
  { httpApiStatus: 400 },
) {}

/** No client credentials at all (neither in the body nor in `Authorization: Basic`). */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { error: rfcError("invalid_request") },
  { httpApiStatus: 400 },
) {}

// ---- wire types ---------------------------------------------------------------

/** RFC 6749 §3.3 scope-token: printable ASCII except space, `"` and `\`. */
const Scope = Schema.String.check(
  Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/),
  Schema.isMaxLength(128),
);

const Scopes = Schema.Array(Scope).check(Schema.isMaxLength(64));

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/** A lifetime in whole seconds on the wire; bounded here, checked against `ApiKeyConfig` in the service. */
const Seconds = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 315_360_000 }),
);

/** `list` row: never the secret or its hash. `start` is the first characters of the secret, for recognising a key. */
export class ApiKeyDto extends Schema.Class<ApiKeyDto>("ApiKeyDto")({
  id: Schema.String,
  name: Schema.String,
  start: Schema.String,
  scopes: Schema.Array(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
}) {}

/** The one response that carries a key: shown once, never retrievable again. */
export class ApiKeyCreatedDto extends Schema.Class<ApiKeyCreatedDto>("ApiKeyCreatedDto")({
  ...ApiKeyDto.fields,
  key: Schema.String,
}) {}

export class ApiKeyClientDto extends Schema.Class<ApiKeyClientDto>("ApiKeyClientDto")({
  clientId: Schema.String,
  name: Schema.String,
  scopes: Schema.Array(Schema.String),
  createdAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
}) {}

/** The one response that carries a client secret: shown once. */
export class ApiKeyClientCreatedDto extends Schema.Class<ApiKeyClientCreatedDto>(
  "ApiKeyClientCreatedDto",
)({
  ...ApiKeyClientDto.fields,
  clientSecret: Schema.String,
}) {}

export class ApiKeyClientSecretDto extends Schema.Class<ApiKeyClientSecretDto>(
  "ApiKeyClientSecretDto",
)({
  clientId: Schema.String,
  clientSecret: Schema.String,
}) {}

export const CreateApiKeyPayload = Schema.Struct({
  name: Name,
  scopes: Schema.optional(Scopes),
  expiresInSeconds: Schema.optional(Seconds),
});
export type CreateApiKeyPayload = typeof CreateApiKeyPayload.Type;

export const RotatePayload = Schema.Struct({
  /** How long the old credential keeps working alongside the new one; default `ApiKeyConfig.rotationGrace`. */
  gracePeriodSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 315_360_000 })),
  ),
  /** Rotating an API key only: the successor's lifetime (default `ApiKeyConfig.defaultExpiresIn`). */
  expiresInSeconds: Schema.optional(Seconds),
});
export type RotatePayload = typeof RotatePayload.Type;

export const RegisterClientPayload = Schema.Struct({
  name: Name,
  scopes: Scopes,
});
export type RegisterClientPayload = typeof RegisterClientPayload.Type;

export const KeyParams = Schema.Struct({ id: Schema.String });
export const ClientParams = Schema.Struct({ clientId: Schema.String });

/**
 * RFC 6749 §4.4.2. Form-encoded, as the RFC requires. `client_id`/`client_secret`
 * are `client_secret_post`; with `Authorization: Basic` (client_secret_basic) they
 * are absent and the header carries them.
 */
export const TokenPayload = Schema.Struct({
  grant_type: Schema.String,
  client_id: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type TokenPayload = typeof TokenPayload.Type;

/** RFC 6749 §5.1: the field names are the RFC's, not this codebase's camelCase. */
export class TokenResponse extends Schema.Class<TokenResponse>("TokenResponse")({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.String,
}) {}

// ---- groups ----------------------------------------------------------------

/**
 * `CsrfProtection` is declared last so it runs first (see `@awthaq/api`'s
 * `Session.ts`): a forged request is rejected before any credential work.
 */
export const ApiKeyGroup = HttpApiGroup.make("apikey")
  .add(
    HttpApiEndpoint.post("create", "/api-key", {
      payload: CreateApiKeyPayload,
      success: ApiKeyCreatedDto,
      error: [ApiKeyScopeNotGrantable, ApiKeyLifetimeInvalid],
    }),
  )
  .add(HttpApiEndpoint.get("list", "/api-key", { success: Schema.Array(ApiKeyDto) }))
  .add(
    HttpApiEndpoint.delete("revoke", "/api-key/:id", {
      params: KeyParams,
      error: ApiKeyNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("rotate", "/api-key/:id/rotate", {
      params: KeyParams,
      payload: RotatePayload,
      success: ApiKeyCreatedDto,
      error: [ApiKeyNotFound, ApiKeyLifetimeInvalid],
    }),
  )
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const ApiKeyClientGroup = HttpApiGroup.make("apikey.client")
  .add(
    HttpApiEndpoint.post("register", "/api-key/client", {
      payload: RegisterClientPayload,
      success: ApiKeyClientCreatedDto,
      error: ApiKeyScopeNotGrantable,
    }),
  )
  .add(HttpApiEndpoint.get("list", "/api-key/client", { success: Schema.Array(ApiKeyClientDto) }))
  .add(
    HttpApiEndpoint.delete("revoke", "/api-key/client/:clientId", {
      params: ClientParams,
      error: ApiKeyClientNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("rotateSecret", "/api-key/client/:clientId/rotate-secret", {
      params: ClientParams,
      payload: RotatePayload,
      success: ApiKeyClientSecretDto,
      error: [ApiKeyClientNotFound, ApiKeyLifetimeInvalid],
    }),
  )
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const ApiKeyTokenGroup = HttpApiGroup.make("apikey.token")
  .add(
    HttpApiEndpoint.post("token", "/api-key/token", {
      payload: TokenPayload,
      success: TokenResponse,
      error: [InvalidClient, InvalidScope, UnsupportedGrantType, InvalidRequest, Api.RateLimited],
    }),
  )
  // BEH-EA-201: a back-channel POST authorized by the client secret in the request, no CSRF (see `Api.BackChannel`).
  .annotate(Api.BackChannel, true);

export const ApiKeyApi = HttpApi.make("auth")
  .add(ApiKeyGroup)
  .add(ApiKeyClientGroup)
  .add(ApiKeyTokenGroup);
