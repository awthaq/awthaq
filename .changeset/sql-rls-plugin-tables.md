---
"@awthaq/sql": minor
"@awthaq/organization": minor
---

Row-level security covers plugin tables (plan 05, ADR-EA-018 decision 10), documented and exercised end to end.

- Opt in with `TenantScope.enableRls({ plugins: auth.tenancy })` (Partitioned tables by their column, Derived tables through their parent's policy) and, for the organization-keyed tables, `includeKeyed: true`. `enableRls()` with no argument still covers only the core tables; `disableRls` drops the `awthaq_tenant` policy from every table that has one. `packages/sql/README.md` and the `TenantMiddleware` header describe the rollout, the non-owner role, the `CrossTenant` witness and `TenantScoped.lift`.
- Every plugin records suite passes `rls` to `TestAuth.runTenantIsolationTests` (webhooks, admin, organization, saml, scim), so `pnpm run test:pg` proves the database confines an unfiltered statement and a witnessed one is not; `organization/test/TenantMiddleware.test.ts` has a Postgres-only case through `layerWithRls`.

Migration: nothing changes unless you opt in. Opting in is `enableRls({ plugins: auth.tenancy })`; backfill `NULL` `"tenantId"` rows first if they must stay visible inside tenant scopes (ADR-EA-018 Consequences). BEH-EA-233.
