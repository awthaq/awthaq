---
"@awthaq/sql": minor
"@awthaq/core": patch
---

`Repositories.UsersRepository`, `UsersRepositoryLive` and `UsersRepositoryEncryptedLive` are removed: `UserStoreSql` owns its statements (identity lookups on `lower(email)` and `phone`, the identity compare-and-swap, the declared-field columns, the keyset page) and stamps the tenant through `Tenant.resolve`. It exports `layer` (metadata as given, requires `SqlClient`) and `layerSealedPii` (metadata sealed at rest, requires `SqlClient | Encryption`); `CoreStoresSql.layer({ encryptPii })` picks between them.

Migration: compose `CoreStoresSql.layer()` / `Persistence.sql()`; `UsersRepositoryEncryptedLive` becomes `Persistence.sql({ encryptPii: true })` or `UserStoreSql.layerSealedPii`. `UsersRepository.insert`/`delete` had no caller outside tests and have no replacement; use the `UserStore` port.
