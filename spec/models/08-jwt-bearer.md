# JWT and Bearer
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-08 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Rewritten to the shipped `Jwt` plugin (`@awthaq/jwt`); the `Bearer` half stays planned (KRS-008, MAPS-009, VB-007) |
---

## What it is
Two related plugins. **`Jwt` is shipped** (`@awthaq/jwt`): it mints and verifies short-lived, self-contained tokens for handing an authenticated caller's identity to a downstream service that cannot consult the session store. **`Bearer` is still planned**: it would let `Authorization: Bearer <token>` reach the same `Authentication` middleware and the same resolved principal that a session cookie does, for clients that cannot hold cookies (today `Authentication` already resolves a bearer *session* token; a JWT-as-credential strategy is not built). Neither replaces the opaque, revocable session that `Sessions` (core) owns — both are additive transports and token kinds on top of it.

## Who asks for it
Native mobile/desktop clients and machine-to-machine callers that cannot rely on cookie storage, and services downstream of the API that need to verify a caller's identity without a round trip to the session store. `research/04-sessions-tokens.md` Q60 frames the JWT plugin exactly this way, citing better-auth's own JWT plugin docs insisting the plugin "is not meant as a replacement for the session," and Q61 documents that both major TypeScript precedents route bearer credentials through the same resolution surface as cookies rather than a parallel one. Q61 also notes bearer tokens are a "documented downgrade from cookie sessions" per RFC 9700's attacker model, which is why response mirroring is opt-in.

## Status
| Property | Value |
|---|---|
| Status | `Jwt`: shipped (`packages/jwt`). `Bearer` / JWT-as-credential re-entry: Planned-Phase2 |
| Priority | P1 |
| Enabler(s) | E3 — Principal-type extension |
| Breaking? | Purely additive: `Authentication` (`archive/PRD.md` §10) already tries schemes in declaration order and returns the first success, so adding a `Jwt` plugin alongside it extends the strategy chain without changing any type an existing application depends on. |

## What is shipped
`Jwt` is an `AuthPlugin.Service` with **`dependsOn: []`**: signing, verification, the JWKS endpoint and introspection work with no other plugin installed. The plugin requires `JwtConfig` (a `Context.Service` with no default — `issuer` is mandatory), `SigningKeyRecords`, `RevocationStore`, `Crypto`, and, through `KeyRing`, `SqlTransaction`. `Sessions` is *not* a dependency: `verifyLive`/`introspectLive` take it per call, and `POST /jwt/introspect` applies the session check only when `Sessions` was composed alongside `Jwt` (TIR-007).

- **Surface:** `sign(principal)`, `verify(token)`, `verifyLive(token)`, `signJWT(payload, { ttl, audience, typ })`, `verifyJWT(token, { audience, typ })`, `jwks`, `introspect`, `introspectLive`; HTTP `GET /jwt/jwks` (public, `Cache-Control: max-age`), `POST /jwt/token` (authenticated mint), `POST /jwt/introspect` (authenticated, RFC 7662 shape).
- **Algorithms:** EdDSA (default), ES256, ES384, RS256, PS256 over one algorithm table; no HS\*. Header `alg` must be in the verifier's allowlist and equal the matched key's own `alg`.
- **Token classes (VB-005/JJS-007/JJS-008):** principal tokens carry header `typ: "at+jwt"` and a mandatory `sub`, and are the only class `verify`, `verifyLive` and `introspectLive` accept; `signJWT` tokens carry `typ: "JWT"`, an optional per-call audience, and are checked by `verifyJWT` (no `sub` required). `nbf`/`iat` are enforced; `aud` may be a string or an array.
- **Claims:** one `RegisteredClaims` schema encodes and decodes (`iss`, `aud`, `exp` required; `iat`, `nbf`, `jti`, `sub` optional). Principal tokens add `sid` and, for an impersonation session, an RFC 8693 `act` claim `{ sub, awthaq_actor_type }` (JR-005).
- **Keys:** `jwt_signing_key`, private JWK stored as an `Encryption` envelope bound to the row's `kid`; automatic rotation with a grace period; one current key enforced by the store; multi-process convergence; emergency retire-now. All specified in [ADR-EA-017](../decisions/017-jwt-signing-key-rotation.md), with encryption-key custody in [ADR-EA-019](../decisions/019-encryption-key-rotation.md). Remote (KMS/HSM) signing via `KeyRing.registerRemoteKey` plus `JwtCodec.RemoteSigner`.
- **Lite verifier:** `Verify.makeVerifier` (`@awthaq/jwt`) verifies tokens in a downstream service with no other awthaq footprint: single-flight, TTL'd JWKS cache, rate-limited refetch on an unknown `kid`. **Limitation:** it cannot check revocation (no `Sessions`); a service needing that calls `POST /jwt/introspect`.
- **Response mirroring:** `JwtConfig.mirrorResponses` (`"off"` default, `"bearer"`, `"always"`) controls whether `x-jwt-token` is mirrored onto authenticated responses through `Authentication.PostAuthResponseHook` (PDR-003).
- **Revocation:** bare `verify` lags session revocation by at most `JwtConfig.ttl` (default 15 minutes); `verifyLive`, `introspectLive` and `/jwt/introspect` (with `Sessions` composed) reflect it at once; a per-token denylist (`RevocationStore`, keyed by `jti`) is consulted by every `introspect*` path.

## What is missing
- The **`Bearer` plugin** / a stateless JWT-as-credential strategy (wayfinder ticket 33): `Authentication` does not accept a JWT as a session credential yet.
- A **machine-credential mint** (`client_credentials`-style issuance to a non-session principal).
- **Inbound token exchange** (RFC 8693 `POST /jwt/exchange` from a foreign issuer): `POST /jwt/token` is a self-decoration mint for an already-authenticated caller, not an exchange. Foreign tokens (e.g. Firebase RS256) are verified with `Verify.makeVerifier` during a dual-run.
- A future `behaviors/` file must specify the claims mapping and revocation-check semantics normatively; none exists yet, so this document, the ADRs and `packages/jwt/test` are the record.

## Verification
`packages/jwt/test/*.test.ts` — codec, key ring (memory and SQL suites), token classes, lite verifier and its cache, HTTP surface, introspection.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
