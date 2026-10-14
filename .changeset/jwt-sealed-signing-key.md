---
"@awthaq/jwt": minor
---

The JWT signing key is a sealed column, and every store failure is `StoreUnavailable` (plan 05).

- `SigningKeyRecord.privateKeyJwk` is `Option<SealedColumn.Sealed<Jwk>>`; `create` still takes a `Redacted` JWK and the records seal it under `jwt_signing_key:<kid>:privateKeyJwk` (the AAD jwt already used, so no legacy spelling and no data change). `SigningKeyRecords.layerMemory` now seals too, so it requires `Encryption`; `SigningKeyRecords.MemoryEnvelopes` is its test seam. A key sealed under a retired encryption key re-seals on read: before this, rotating `AWTHAQ_ENCRYPTION_KEY_ID` left every signing key on the retired kid forever, so the old key could never be dropped.
- `Jwt` opens the current key where it signs with `SealedColumn.orDie`: a key that does not open is the `sealedColumn.readable` defect (was `SigningKeyUndecodable`; a public key that does not decode keeps `SigningKeyUndecodable`).
- `SigningKeyRecords`, `RevocationStore`, `KeyRing` and the `Jwt` methods (`sign`, `signJWT`, `verify`, `verifyJWT`, `introspect`, `jwks`) fail with `StoreUnavailable` instead of dying; `GET /jwt/jwks` declares it, and the bearer resolver lets it through (a store outage is no longer a `401`).

Migration: provide `Encryption` to `SigningKeyRecords.layerMemory`; open `record.privateKeyJwk` with `SealedColumn.orDie(sealed.open)`; handle `StoreUnavailable` on the widened methods; run `SealedColumn.sweep` on `jwt_signing_key.privateKeyJwk` to move rows still on a retired encryption key. BEH-EA-296.
