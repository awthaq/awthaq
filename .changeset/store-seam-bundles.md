---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/test": minor
---

Breaking (pre-1.0, ADR-EA-034 section 2): the twin layers are removed in favour of two matched persistence bundles (ADR-EA-041, ADR-EA-014 rev 1.3, plan 02 phase 7).

- `@awthaq/core` gains `Persistence`: `Persistence.memory` (the five `Ref` store adapters plus `SqlTransaction.layerNoop`) and `Persistence.sql({ encryptPii? })` (the five SQL store adapters over the ambient `SqlClient`, the six repositories they need, and `SqlTransaction.layerSql`; it requires `SqlClient | Encryption`).
- `Users`, `Accounts`, `Sessions`, `Verification` and `AuditLog` lose `layerMemory` and `layerSql`; `X.layer` is the only layer and reads its store from the bundle. `@awthaq/test` gains `TestEncryption.layer` (a fixed-key `Encryption` for SQL test compositions), and `TestAuth` composes `Persistence.memory`.

Migration: `Users.layerMemory`, `Accounts.layerMemory`, `Sessions.layerMemory`, `Verification.layerMemory`, `AuditLog.layerMemory` and their `layerSql` twins are removed. Use `X.layer` and provide `Persistence.memory` (tests, single process) or `Persistence.sql({ encryptPii? })` (production) once. `Persistence.sql()` includes `SqlTransaction.layerSql`, so remove your own. The six `Repositories.*Live` layers no longer need to be assembled by hand. `Repositories.SessionsRepository.markReused` is replaced by `markReusedOnce`. See ADR-EA-041, ADR-EA-014 rev 1.3 and BEH-EA-035/053/054/062/231.
