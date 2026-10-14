---
"@awthaq/jwt": minor
---

`Jwt.records` is the plugin's signing-key and revocation stores as one matched `{ memory, sql }` bundle, the stores' service keys gain the `/records/` segment, and `Jwt.layer` now provides its key ring itself.

- `SigningKeyRecords` and `RevocationStore` are keyed `awthaq/jwt/records/<Name>`; the bundle provides both over memory and over SQL (the `MemoryEnvelopes` test seam is not part of it).
- `Jwt.layer` absorbs `KeyRing.KeyRing.layer` (always required, a `LayerRef` over `SigningKeyRecords`); it stays in the output. `JwtConfig` stays the host's (configuration).

Migration: remove your own `KeyRing.KeyRing.layer` from the host graph (keeping it is harmless but redundant). Code that built a `Context` by the old key string must use the class. A host replaces the pair of `layerMemory` / `layerSql` layers with `Jwt.records.memory` / `Jwt.records.sql`.
