# @awthaq/jwt

Short-lived, self-contained, cryptographically signed JWTs representing an already-authenticated caller: EdDSA/ES256 signing, a JWKS endpoint with grace-period key rotation, an explicit mint endpoint, RFC 7662-shaped introspection, a standalone lite verifier for downstream services, and general-purpose signing primitives. Design decisions: [`.scratch/jwt/spec.md`](../../.scratch/jwt/spec.md) and [`spec/decisions/017-jwt-signing-key-rotation.md`](../../spec/decisions/017-jwt-signing-key-rotation.md).

## Signing keys at rest

`SigningKeyRecords.layerSql` persists signing keys in `jwt_signing_key`. The private half (`privateKeyJwk`) is stored as an `@awthaq/ports` `Encryption` envelope (AES-256-GCM, kid-tagged) whose additional authenticated data is bound to the row's own `kid`, so a database dump or read replica does not yield signing keys and ciphertext copied onto another row fails to decrypt. The public JWK is stored as plain JSON.

- `layerSql` requires `Encryption` (and therefore a `KeyProvider`, e.g. `KeyProvider.layerEnv` with `AWTHAQ_ENCRYPTION_KEYS` / `AWTHAQ_ENCRYPTION_KEY_ID`). Its requirement type is `SqlClient | Encryption`.
- An undecryptable signing key (retired encryption key, tampered or swapped row) is a deployment fault and dies with a clear message rather than being skipped. Keep a retired encryption key in the keyset until no signing key row was written under it (see [ADR-EA-019](../../spec/decisions/019-encryption-key-rotation.md)).
- `layerMemory` keeps the JWK in process memory unencrypted; use it for tests and single-process deployments only.
- To keep private material out of the database entirely, register a KMS/HSM-held key with `KeyRing.registerRemoteKey` and provide a `JwtCodec.RemoteSigner`; the row then carries the public JWK only.

There is no legacy-plaintext shim: rows written before this change must be re-minted (`KeyRing.rotateNow`).

## Key rotation

Keys rotate automatically every `keyRotationInterval` (default 90 days); the retired key stays in the JWKS and keeps verifying for `keyGracePeriod` (default 30 days). Size the grace period to at least the longest token lifetime plus the longest JWKS cache a verifier keeps. For a suspected compromise, retire the key immediately (`KeyRing.rotateNow({ retireNow: true })`) instead of waiting out the grace period. See ADR-EA-017 for the routine and emergency procedures.
