---
"@awthaq/sql": minor
---

`Repositories.VerificationRepository` and `VerificationReservationsRepository` (and their `Live` layers) are removed: `VerificationStoreSql.layer` owns the statements over `verification_tokens` and `verification_reservations` (one adapter, as they are one port) and stamps the tenant through `Tenant.resolve`.

Migration: compose `CoreStoresSql.layer()` / `Persistence.sql()` (or `VerificationStoreSql.layer` over a `SqlClient`); `VerificationRepository.insert`/`findById`/`delete` had no caller outside tests and have no replacement; use the `VerificationStore` port.
