# @awthaq/jwt

Short-lived, self-contained, cryptographically signed JWTs representing an already-authenticated caller: signing with EdDSA, ES256, ES384, RS256 or PS256 (never HS\*), a JWKS endpoint with grace-period key rotation, an explicit mint endpoint, RFC 7662-shaped introspection, a standalone lite verifier for downstream services, and general-purpose signing primitives. Design decisions: [`.scratch/jwt/spec.md`](../../.scratch/jwt/spec.md), [`spec/models/08-jwt-bearer.md`](../../spec/models/08-jwt-bearer.md) and [ADR-EA-017](../../spec/decisions/017-jwt-signing-key-rotation.md).

## Token classes

Principal tokens (`Jwt.sign`, `GET /jwt/token`, response mirroring) carry header `typ: "at+jwt"` (RFC 9068) and a mandatory `sub`; `Jwt.verify`, `verifyLive` and `introspectLive` accept only those. Tokens from `signJWT` carry `typ: "JWT"` (override with `options.typ`), may pick their audience per call (`options.audience`), and are checked by `verifyJWT`, which does not require a `sub`. A `signJWT` payload with a forged `sid` therefore cannot pass as a principal token. The header `alg` must be in the verifier's allowlist and equal the algorithm of the key its `kid` names (RFC 8725); `nbf`/`iat` are honoured.

## JWT as a bearer credential (stateless profile)

By default a minted JWT is a delegation token for downstream services: presented to the API that issued it as `Authorization: Bearer` it answers 401, and only opaque session tokens authenticate. `JwtConfig.acceptAsBearer: true` (default `false`) opts in to accepting the plugin's own principal tokens (`typ: "at+jwt"`) at the origin as well.

- **How.** The plugin adds a `jwt` contribution to `@awthaq/server`'s bearer-credential registry (`Authentication.contribute`, ADR-EA-012); `Authentication` offers every `Authorization: Bearer` credential to the registered contributions first and only falls back to an opaque session lookup when none claims it. Provide `Authentication.CredentialResolversLive` once in the composition; opting in without it fails the build. `@awthaq/api-key` contributes a second resolver (service tokens) to the same registry.
- **Stateless.** Verification is bare `Jwt.verify` (signature, `iss`, `aud`, `exp`, `typ`), with no session-store round trip. A JWT resolves to a `UserPrincipal` from its `sub`, `sid` and `act` claims; there is no session row, so nothing is rotated and no `set-auth-token` header is sent.
- **Revocation lag.** A revoked session's JWT keeps authenticating until its own `exp`, so the lag is at most `JwtConfig.ttl` (default 15 minutes). Shorten `ttl`, or keep the default and use `verifyLive`/`/jwt/introspect` where freshness matters.
- **Downstream-only tokens never re-enter.** `signJWT(payload, { audience: "inventory-service" })` mints a token whose `aud` is not this API's, so the origin rejects it by the ordinary audience check. `sign` (the mint endpoint and the response mirror) keeps `aud` = `JwtConfig.audience`, i.e. re-entrant when `acceptAsBearer` is on.
- **Stateless recipe (no SQL, no migrations).** For an edge or serverless deployment: `Sessions.layerMemory` (only there to satisfy `AuthenticationLive`'s type, it is never consulted for a JWT), `SigningKeyRecords.layerMemory`, `RevocationStore.layerMemory`, `SqlTransaction.layerNoop`, `Authentication.CredentialResolversLive` and `JwtConfig.config({ issuer, acceptAsBearer: true })`. `layerMemory` keeps signing keys in one process, so run a single instance or a shared key store.

## Signing keys at rest

`SigningKeyRecords.layerSql` persists signing keys in `jwt_signing_key`. The private half (`privateKeyJwk`) is stored as an `@awthaq/ports` `Encryption` envelope (AES-256-GCM, kid-tagged) whose additional authenticated data is bound to the row's own `kid`, so a database dump or read replica does not yield signing keys and ciphertext copied onto another row fails to decrypt. The public JWK is stored as plain JSON.

- `layerSql` requires `Encryption` (and therefore a `KeyProvider`, e.g. `KeyProvider.layerEnv` with `AWTHAQ_ENCRYPTION_KEYS` / `AWTHAQ_ENCRYPTION_KEY_ID`). Its requirement type is `SqlClient | Encryption`.
- An undecryptable signing key (retired encryption key, tampered or swapped row) is a deployment fault and dies with a clear message rather than being skipped. Keep a retired encryption key in the keyset until no signing key row was written under it (see [ADR-EA-019](../../spec/decisions/019-encryption-key-rotation.md)).
- `layerMemory` keeps the JWK in process memory unencrypted; use it for tests and single-process deployments only.
- To keep private material out of the database entirely, register a KMS/HSM-held key with `KeyRing.registerRemoteKey` and provide a `JwtCodec.RemoteSigner`; the row then carries the public JWK only.

There is no legacy-plaintext shim: rows written before this change must be re-minted (`KeyRing.rotateNow()`).

## Key rotation

Keys rotate automatically every `keyRotationInterval` (default 90 days) or as soon as `JwtConfig.algorithm` names a different algorithm than the current key's; the retired key stays in the JWKS and keeps verifying for `keyGracePeriod` (default 30 days, never shorter than `ttl`). Size the grace period to at least the longest token lifetime plus the longest JWKS cache a verifier keeps.

- Several processes may share one store. The store allows at most one current key (a partial unique index; run the plugin migrations), the mark-rotated and mint steps commit in one `SqlTransaction`, and a process that loses a rotation race adopts the winner's key. `KeyRing` therefore requires `SqlTransaction` (`SqlTransaction.layerSql`, or `layerNoop` for in-memory use).
- A busy process re-reads the store every `keyCacheMaxAge` (default 5 minutes), and `Jwt.verify` forces one rate-limited re-read (`keyMinRefreshInterval`) when a token names an unknown `kid`, so rotations made elsewhere converge.
- **Emergency:** for a suspected compromise run `KeyRing.rotateNow({ gracePeriod: Duration.zero })`, which retires the current key at once, or `KeyRing.revoke(kid)` for a key that was already rotated out. Verifiers stop trusting it once their JWKS cache (`cacheTtl`, `Cache-Control: max-age` from `jwksMaxAge`) refreshes. See ADR-EA-017 for the full routine and emergency procedures.
- Migrating from another issuer: `KeyRing.importKey({ kid, alg, publicKeyJwk })` adds a foreign public key as a verification-only key so tokens minted before the migration keep verifying.

## Lite verifier

`Verify.makeVerifier({ jwksUrl, issuer, audience, algorithms, expectedTyp?, requireSubject?, clockSkew?, cacheTtl?, minRefetchInterval? })` verifies tokens in a downstream service with no other awthaq footprint. The JWKS is cached for `cacheTtl` (default 10 minutes), fetched single-flight, and refetched at most once per `minRefetchInterval` (default 30 seconds) when a token names an unknown `kid`. It cannot check revocation.

Firebase dual-run: Firebase ID tokens are RS256 with `iss` `https://securetoken.google.com/<projectId>` and `aud` `<projectId>`. `makeVerifier({ jwksUrl: <Firebase securetoken JWKS>, issuer, audience: <projectId>, algorithms: ["RS256"], expectedTyp: "JWT" })` verifies them; an app handler can then resolve or create the user and call `Sessions.issue`. `GET /jwt/token` is a self-decoration mint for an already-authenticated caller, not an RFC 8693 token exchange.
