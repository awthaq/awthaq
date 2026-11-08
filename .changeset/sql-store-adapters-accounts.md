---
"@awthaq/sql": minor
---

`Repositories.AccountsRepository` and `AccountsRepositoryLive` are removed: `AccountStoreSql.layer` owns its statements, seals the three provider-token columns under `accounts:<id>:<field>`, takes the `FOR UPDATE` of the last-account guard, and stamps the tenant through `Tenant.resolve`. It requires `SqlClient | Encryption`.

Migration: compose `CoreStoresSql.layer()` / `Persistence.sql()` (or `AccountStoreSql.layer` over a `SqlClient` and an `Encryption`). `AccountsRepository.insert`/`findById`/`listByUser` had no caller outside tests and have no replacement; use `AccountStore.insertIfAbsent` and the identity reads.
