---
"@awthaq/sql": minor
---

`Repositories.SessionsRepository`, `SessionsRepositoryLive` and `SessionsRepositoryEncryptedLive` are removed: `SessionStoreSql` owns its statements, both Postgres advisory locks beside the statements they serialize, the read routing of `listLive` and the tenant stamp (`Tenant.resolve`). It exports `layer` (`ipAddress`/`userAgent` as given, requires `SqlClient`) and `layerSealedPii` (sealed at rest, requires `SqlClient | Encryption`); `CoreStoresSql.layer({ encryptPii })` picks between them. `Repositories.ts` is now empty and is deleted with the `Repositories` export.

Migration: compose `CoreStoresSql.layer()` / `Persistence.sql()`; `SessionsRepositoryEncryptedLive` becomes `Persistence.sql({ encryptPii: true })` or `SessionStoreSql.layerSealedPii`. A `ReadRouting.replica(...)` provided above the bundle still reaches the session and audit adapters.
