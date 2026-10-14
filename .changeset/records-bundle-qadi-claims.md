---
"@awthaq/qadi": minor
---

`UserClaims` persists through a record store, `UserClaimsRecords`, declared as `UserClaims.records` (a matched `{ memory, sql }` bundle), and `UserClaims.layerSql` is removed.

- New record store `UserClaimsRecords` (key `awthaq/qadi/records/UserClaims`) with `layerMemory` and `layerSql`, the `read`/`modify` pair the two copies of `UserClaims` already shared internally. `UserClaims.layer` requires it.

Migration: `UserClaims.layer` now requires `UserClaimsRecords`: provide `UserClaims.records.memory` beneath it. `UserClaims.layerSql` is gone: use `UserClaims.layer` with `UserClaims.records.sql`. A composition served through `Auth.make` and `TestAuth.layer` needs nothing: the harness selects the bundle.
