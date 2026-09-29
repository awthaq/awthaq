# API Keys
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-07 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): `@awthaq/api-key` implemented — API keys, `client_credentials` clients and service tokens, rotation, the `x-api-key` transport (ADR-EA-022; OCM-001/OCM-002/OCM-005/MAPS-003) |
---

## What it is

Two credential types for server-to-server and CI callers rather than interactive
users, both owned by one plugin because they serve different calling patterns:

1. **API keys**: a caller creates a named, scoped, long-lived key; the raw key is
   shown once and only its hash is stored; presenting it in `x-api-key` resolves to
   an `ApiKeyPrincipal` carrying the key's own scopes.
2. **`client_credentials` clients** (RFC 6749 §4.4): for service-to-service callers
   that want a short-lived, cheaply verifiable token instead of presenting a static
   secret on every call. A client secret is exchanged at `POST /api-key/token` for a
   15-minute JWT, which resolves to a `ServicePrincipal`.

Its scopes are what qadi turns into permissions on the other side of the
authorization boundary (BEH-EA-140/141). `packages/oauth` stays a pure client of
external identity providers and never issues tokens.

## Who asks for it

`research/07-passwords-2fa.md` Q59 surveys four production implementations
(Stripe, WorkOS AuthKit, Clerk, better-auth's `apiKey` plugin) that converge on
the same shape — hash-at-rest, show-once, scoped, an explicit principal kind
rather than a mocked user session — which is strong evidence this is asked
for by essentially any application that exposes an API to scripts, CI
pipelines, or other services rather than only to browsers. A SCIM directory
bearer token is just such a key, scoped `scim:*` (SCP-002).

## Status

| Property | Value |
|---|---|
| Status | Planned-Phase2 (built: `@awthaq/api-key`) |
| Priority | P1 |
| Enabler(s) | E3 — Principal-type extension |
| Breaking? | Additive: `ApiKeyPrincipal`/`ServicePrincipal` were already members of the `Principal` union (now carrying `scopes`), and the machine tier is a separate middleware, so no existing group can receive one. |

## As built

- **Key format** `{prefix}{keyId}.{secret}` (`ak_<uuidv7>.<64 hex>`): the same
  `id.secret` shape as a session token. `keyId` is the lookup key; only
  `SHA-256(secret)` is stored (`SecretHash`, shared with `Sessions`), compared in
  constant time, with the same hash and compare work whether or not the id exists.
  SHA-256, not argon2id: the secret is 256 random bits and the request path must
  not let a caller burn password-grade CPU. `start` (the first characters of the
  credential — prefix and public id) is stored for list UX and never includes any
  of the secret.
- **Lifecycle**: `create(owner, { name, scopes, expiresIn? })` (key shown once),
  `list`, `revoke` (immediate), `rotate`, and per-request `resolve`. Expiry is
  `defaultExpiresIn`/`maxExpiresIn`; scopes are bounded by `grantableScopes` when
  set. There is no cross-request cache: a revoked or expired key is dead on its next
  request. `lastUsedAt` is written at most once per `lastUsedGranularity`.
- **Transport**: `x-api-key` only; `Authorization: Bearer` is reserved for JWTs
  ([ADR-EA-022](../decisions/022-api-key-rotation-and-transport.md)).
- **Rotation**: dual-validity for a bounded window (default 24 hours, at most 30
  days) for keys, and at most two valid secrets per client (ADR-EA-022).
- **Client credentials**: `registerClient`/`revokeClient`/`rotateClientSecret`;
  `POST /api-key/token` accepts `grant_type=client_credentials` with
  `client_secret_post` or `client_secret_basic`, negotiates scope (requested ∩
  registered, never more; nothing in common is `invalid_scope`), answers RFC 6749
  §5.1/§5.2 shapes, and mints a JWT through `@awthaq/jwt` (`typ: "service+jwt"`,
  `sub: "service:<clientId>"`, `scope`, `exp` from `serviceTokenTtl`). Verifying
  it is a pure signature check with no database hit; the accepted trade-off is that
  a revoked client blocks *new* tokens at once while a minted token lives until its
  expiry. The endpoint is rate-limited per IP and per `client_id`.
- **Resolution** goes through `@awthaq/server`'s credential-resolver registry
  ([BEH-EA-066](../behaviors/09-authentication-middleware.md)); the plugin contributes
  the `apiKey`-carrier key resolver and the `bearer`-carrier service-token resolver.
  Groups meant for machine callers declare `Api.MachineAuthentication`;
  `Api.Authentication` (the user tier) never admits these principals, so handlers
  that assume a session cannot receive one.
- **Authorization** is not built here (ADR-EA-009): `@awthaq/qadi`'s default subject
  resolver maps `scopes` shaped like `resource:action` onto `AuthSubject.permissions`
  (BEH-EA-140/141), and this plugin never claims the exclusive `SubjectResolver` slot
  (ADR-EA-012).
- **Persistence**: `apikey_key` and `apikey_client`, memory and SQL (SQLite and
  Postgres) layers. Lifecycle events: `auth.apiKey.created`/`revoked`/`rotated`,
  `clientRegistered`/`clientRevoked`/`clientSecretRotated`.

## Worked example

```ts
const plugins = [Jwt, ApiKey] as const   // ApiKey dependsOn Jwt: it mints the service tokens

// A signed-in user creates a key (the response carries `key` once, then never again)
//   POST /api-key { name: "ci", scopes: ["project:read"], expiresInSeconds: 7776000 }
// server-to-server call, on a group that declares Api.MachineAuthentication
//   curl -H "x-api-key: ak_…" https://app.example.com/machine/projects
// CurrentPrincipal → ApiKeyPrincipal { ref: { type: "apikey", id: keyId }, scopes: ["project:read"] }
// SubjectResolver → AuthSubject { id: "apikey:<keyId>", permissions: ["project:read"] }

// Service-to-service: register a client, then exchange its secret for a short-lived token
//   POST /api-key/token  grant_type=client_credentials&client_id=…&client_secret=…&scope=invoices:read
//   → { access_token, token_type: "Bearer", expires_in: 900, scope: "invoices:read" }
//   curl -H "Authorization: Bearer <access_token>" https://app.example.com/machine/invoices
// CurrentPrincipal → ServicePrincipal { ref: { type: "service", id: clientId }, scopes: ["invoices:read"] }
```

The qadi side (`archive/design/usage-qadi.md`) resolves an `ApiKey` principal to a subject with
`id: "apikey:<keyId>"` and `permissions` equal to the key's scopes, alongside the equivalent
`Service` kind (`id: "service:<clientId>"`). The `ApiKey` plugin's job stops at producing a scoped
principal; turning scopes into qadi permissions is the default resolver's, not this plugin's.

## What is missing

- **Erasure cascade**: keys and clients name an owner user, but account erasure does not yet delete
  them (wayfinder ticket 30 owns the plugin-data cascade); revoking is the interim answer.
- **Per-key IP allowlists, per-key rate limits and usage metering** are not built.
- **A configurable header name**: the contract is static, so `x-api-key` is fixed.
- **Failure-only throttling** of resolution: the per-IP resolve limit counts every attempt (the
  `RateLimiter` port has no "peek"), so it is flood protection with a deliberately high default, not a
  strict failed-attempt lockout.
- A revoked client's already-minted service tokens are honoured until they expire (`serviceTokenTtl`).

## Verification

`packages/api-key/test/ApiKey.test.ts` (key lifecycle, rotation and policy, memory and migrated SQL),
`packages/api-key/test/ServiceToken.test.ts` (clients, scope negotiation, secret rotation),
`packages/api-key/test/AuthHttp.test.ts` (the real HTTP surface, both tiers, RFC 6749 shapes, throttles),
`packages/server/test/CredentialResolvers.test.ts` (the registry), `packages/qadi/test/SubjectResolver.test.ts`
(scopes to permissions).

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
