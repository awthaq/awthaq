---
"@awthaq/core": minor
"@awthaq/cli": minor
"@awthaq/admin": minor
"@awthaq/api-key": minor
"@awthaq/device-authorization": minor
"@awthaq/jwt": minor
"@awthaq/magic-link": minor
"@awthaq/oauth": minor
"@awthaq/organization": minor
"@awthaq/passkey": minor
"@awthaq/password": minor
"@awthaq/qadi": minor
"@awthaq/roles": minor
"@awthaq/saml": minor
"@awthaq/scim": minor
"@awthaq/two-factor": minor
"@awthaq/webhooks": minor
---

Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).

- `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
- `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
- Every first-party plugin declares its tables (see ADR-EA-018 decision 10).

Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
