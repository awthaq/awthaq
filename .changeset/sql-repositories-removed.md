---
"@awthaq/sql": minor
---

`Repositories` is removed from `@awthaq/sql`: each core store adapter (`UserStoreSql`, `AccountStoreSql`, `SessionStoreSql`, `VerificationStoreSql`, `AuditLogStoreSql`) owns its statements, and `CoreStoresSql.layer({ encryptPii? })` is the bundle `Persistence.sql()` re-exports (ADR-EA-041 rev 1.3, BEH-EA-035). `StoreContract` now also runs on libSQL.

Migration: replace any `Repositories.*Live` wiring with `Persistence.sql()` (or `CoreStoresSql.layer()`); `UsersRepositoryEncryptedLive`/`SessionsRepositoryEncryptedLive` become `Persistence.sql({ encryptPii: true })` or `UserStoreSql.layerSealedPii`/`SessionStoreSql.layerSealedPii`. Repository methods that only tests called (`UsersRepository.insert`/`delete`, `AccountsRepository.insert`/`findById`/`listByUser`, `VerificationRepository.insert`/`findById`/`delete`) have no replacement; use the store ports.
