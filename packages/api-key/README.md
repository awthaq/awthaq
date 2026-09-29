# @awthaq/api-key

Machine identity for awthaq: long-lived **API keys** for scripts and CI, and **`client_credentials` clients** that mint short-lived service tokens. Both resolve to non-user principals (`ApiKeyPrincipal`, `ServicePrincipal`) that carry their own scopes; `@awthaq/qadi` turns those scopes into permissions. Mounted under the shared `"auth"` id, groups `apikey`, `apikey.client` and `apikey.token`.

See [`spec/models/07-api-keys.md`](../../spec/models/07-api-keys.md) and [ADR-EA-022](../../spec/decisions/022-api-key-rotation-and-transport.md).

## Composition

`ApiKey` depends on `Jwt` (it signs the service tokens) and needs the credential-resolver registry from `@awthaq/server`. It requires `ApiKeyRecords` and `ApiKeyClientRecords` (`layerMemory` or `layerSql`, migrated with `ApiKey.migrations`), `Crypto`, `RateLimiter`, `RateLimits`, `ClientAddress` and `AuthEvents`; the application provides them.

```ts
import { Auth } from "@awthaq/core";
import { Jwt, JwtConfig } from "@awthaq/jwt";
import { Authentication } from "@awthaq/server";
import { ApiKey, ApiKeyClientRecords, ApiKeyRecords } from "@awthaq/api-key";

const auth = Auth.make([Jwt.Jwt, ApiKey.ApiKey]);

const layers = Layer.mergeAll(
  // The registry sits below every plugin that contributes to it.
  Authentication.CredentialResolversLive,
  ApiKeyRecords.layerSql,
  ApiKeyClientRecords.layerSql,
  ApiKey.config({ prefix: "ak_", defaultExpiresIn: Duration.days(90) }),
  JwtConfig.config({ issuer: "https://app.example.com" }),
);
```

Machine callers reach a group only if it declares `Api.MachineAuthentication` (provide `Authentication.MachineAuthenticationLive`):

```ts
const ProjectsGroup = HttpApiGroup.make("projects")
  .add(HttpApiEndpoint.get("list", "/machine/projects", { success: Projects }))
  .middleware(Api.MachineAuthentication);
```

`Api.Authentication` is the user tier: it never admits an API key or a service token, so handlers that assume a session cannot receive one. The management endpoints below sit behind it, so only a signed-in user can mint or rotate credentials.

## API keys

- **Format** `ak_<keyId>.<secret>`: `keyId` is a UUIDv7 lookup key, `secret` 32 random bytes as hex. Only `SHA-256(secret)` is stored, compared in constant time with the same work whether or not the id exists. The key is returned once, at creation.
- **Transport** `x-api-key` only. `Authorization: Bearer` is reserved for JWTs.
- **Endpoints** (session + CSRF): `POST /api-key` `{ name, scopes?, expiresInSeconds? }`, `GET /api-key`, `DELETE /api-key/:id` (immediate revoke), `POST /api-key/:id/rotate` `{ gracePeriodSeconds? }`. An unknown key and someone else's key are the same `404`.
- **Rotation** mints a successor and lets the old key live on for a grace window (default 24 hours, at most 30 days): both resolve until it ends, then only the successor. To respond to a leak, `DELETE` the key (or rotate with `gracePeriodSeconds: 0`).
- **Scopes** are the key's own grants. Without `grantableScopes` a user chooses their own, so list what your application is prepared to hand out. Scopes shaped like `resource:action` become qadi permissions; anything else names no permission.
- **A SCIM directory token** is an ordinary key scoped `scim:*`.

## Client credentials (service tokens)

`POST /api-key/client` registers a client (`clientId`, and a `clientSecret` shown once); `POST /api-key/token` is the RFC 6749 §4.4 endpoint:

```sh
curl -X POST https://app.example.com/api-key/token \
  -d grant_type=client_credentials -d client_id=svc_... -d client_secret=cs_... -d scope=invoices:read
# {"access_token":"eyJ...","token_type":"Bearer","expires_in":900,"scope":"invoices:read"}
curl -H "Authorization: Bearer eyJ..." https://app.example.com/machine/invoices
```

`client_secret_post` and `client_secret_basic` are both accepted. The granted scope is the requested scopes intersected with the registered ones (never more); a request sharing none of them is `invalid_scope`. Errors are RFC 6749 §5.2 shaped (`invalid_client` 401, `invalid_request`, `invalid_scope`, `unsupported_grant_type` 400). The endpoint is rate-limited per IP and per `client_id`.

The token is a JWT signed by `@awthaq/jwt` (`typ: "service+jwt"`, `sub: "service:<clientId>"`, `exp` = `serviceTokenTtl`, default 15 minutes) and verifying it is a pure signature check, with no database hit. **The trade-off:** revoking a client (`DELETE /api-key/client/:clientId`) or rotating its secret blocks new tokens at once, but a token already minted stays valid until it expires. Set `serviceTokenTtl` to the revocation lag you can accept. `serviceTokenAudience` sets the token's `aud` for a downstream service that verifies with the lite verifier; unset, the token is accepted by this API.

A client keeps at most two valid secrets: `POST /api-key/client/:clientId/rotate-secret` issues a new one and the old one works for the grace window.

## Configuration (`ApiKey.config({...})`)

| Option                                     | Default                          |                                                                          |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| `prefix`                                   | `ak_`                            | letters, digits, `_`, `-` only                                           |
| `defaultExpiresIn` / `maxExpiresIn`        | unset                            | with `maxExpiresIn`, a key created with no expiry gets it                |
| `rotationGrace` / `maxRotationGrace`       | 24 hours / 30 days               |                                                                          |
| `grantableScopes`                          | unset (any)                      | applies to keys and clients                                              |
| `serviceTokenTtl` / `serviceTokenAudience` | 15 minutes / the JWT audience    |                                                                          |
| `lastUsedGranularity`                      | 1 minute                         | `lastUsedAt` is written at most this often                               |
| `resolveRateLimit`                         | 3000 per minute per IP           | counts every `x-api-key` attempt; deliberately high, lower it to tighten |
| `tokenRateLimit`                           | 60/min per IP, 30/min per client |                                                                          |

## Limits

- The header name is fixed (`x-api-key`): the contract is static.
- Deleting an account does not yet delete its keys and clients (revoke them); the plugin-data erasure cascade is tracked separately.
- The per-IP resolve limit counts all attempts, not only failures, because the `RateLimiter` port has no way to peek at a bucket.
