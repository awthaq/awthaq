---
"@awthaq/sql": minor
---

`Repositories.AuditLogRepository` and `AuditLogRepositoryLive` are removed: `AuditLogStoreSql.layer` owns its statements, the ADR-EA-037 savepoint, the `FOR UPDATE` branch of the erasure rewrite and the read routing, and stamps the tenant through `Tenant.resolve`.

Migration: compose `CoreStoresSql.layer()` / `Persistence.sql()` (or `AuditLogStoreSql.layer` over a `SqlClient`); a repository method had no caller outside its adapter.
