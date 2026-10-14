---
"@awthaq/admin": minor
---

Impersonation records are tenant-scoped by the store and cross-tenant access is a witness (plan 05).

- `ImpersonationRecords`: `findBySessionId`, `endEpisode` and `list` take an optional `TenantScoped.CrossTenant` instead of `{ anyTenant: true }`; `closeExpired(grant, now)` and `verifyChain(grant)` are maintenance and take a witness, and their statements run under `TenantScoped.lift`, so they still see every tenant inside a request's Postgres RLS transaction. The SQL predicate is `"tenantId" = $1` / `IS NULL` (index-friendly) instead of `IS NOT DISTINCT FROM`; inserts stamp through `Tenant.stamp`.
- Every records method fails with `StoreUnavailable` (503) instead of dying; `Admin.list` and `Admin.sweepExpired` widen accordingly.

Migration: `ImpersonationRecords.TenantScope` is removed; replace `{ anyTenant: true }` with `TenantScoped.crossTenant("<why>")` (from `@awthaq/sql`), and pass a witness to `closeExpired` and `verifyChain`. A host that implements `ImpersonationRecordsShape` adopts the same signatures. BEH-EA-326/327.
