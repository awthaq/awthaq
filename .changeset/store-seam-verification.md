---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

`Verification` is written once, over a new `VerificationStore` port (ADR-EA-041, plan 02 phase 3).

- `@awthaq/ports` gains `VerificationStore` (`upsertLive`, `present`, `settle`, `transaction`, `reserve`, `deleteByUser`, `purgeExpired`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `VerificationStoreSql.layer` over the token and reservation repositories. `@awthaq/core`'s `Verification` gains `layer` (requires `VerificationStore`, `Crypto` and `AuthEvents`); `Verification.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
- `@awthaq/test` gains `StoreContract.verification`, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
- Behaviour, in every backend: a consumed token is kept as replay evidence in memory too (it was deleted there) until `purgeExpired` passes it; a token's payload is JSON text encoded once by the service, so a value JSON cannot carry (a `bigint`, a cycle) is a defect everywhere and a `DateTime` or class instance comes back in its JSON form everywhere (memory returned the object itself); the memory adapter stamps the ambient tenant on tokens and reservations like SQL.
- `@awthaq/sql` repositories: `VerificationToken.payload` is the JSON text (the model no longer decodes it, `"null"` when there is none), `VerificationRepository.upsertLive` takes it as a string, and `deleteAllByUser` resolves to the number of rows deleted.

Migration: a host that reads `VerificationRepository` or the `VerificationToken` model directly handles `payload` as JSON text. A caller that passed a payload with a non-JSON value (a `DateTime`, a `bigint`) to `Verification.issue` and relied on memory returning it by reference now gets its JSON form (or a defect); pass JSON-encodable values. BEH-EA-061, BEH-EA-062, BEH-EA-122.
