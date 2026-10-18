---
"@awthaq/admin": patch
---

`AdminAccounts` reads `AdminConfig` per operation, like `Admin` and `AdminTenants` (ADR-EA-018 Decision 8, BEH-EA-236): a tenant's `canDeleteUsers`, `canManageCredentials`, `passwordPolicy` and `links.changeEmail` now apply to that tenant's requests. Before, they were read once at layer build, so a tenant could not refuse a deletion or credential change the deployment-wide configuration allowed.

Migration: a `TenantConfig` lookup that returns `Admin.config({ … })` for a tenant now also governs that tenant's `deleteUser`, `setUserEmail` and `setUserPassword`. `config(partial)` fills the fields it does not name with the deny-all defaults, so a lookup that names only `canManageUsers` turns deletion and credential administration off in that tenant, and resets its `passwordPolicy` and `links`. Name every capability the tenant keeps.
