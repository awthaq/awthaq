---
"@awthaq/scim": minor
---

The SCIM records are scoped by their organization and fail with `StoreUnavailable` (plan 05).

- `ScimRecords.findConnectionByTokenHash` (the bearer token is the capability that finds a connection before any tenant is known), `linksOfResource` and `unlinkResource` (erasure and export read a person's links in every connection) take a `TenantScoped.CrossTenant` as their first argument and run under `TenantScoped.lift`. `scim_connection` is Keyed by `organizationId`; `scim_resource` is Derived through it.
- Every `ScimRecords` and `ScimConnectionStore` method fails with `StoreUnavailable` instead of dying; the SCIM bearer middleware declares it, so an outage while authenticating answers `503` rather than a `401` that would make a directory service discard a working token.

Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to `findConnectionByTokenHash`, `linksOfResource` and `unlinkResource`; handle `StoreUnavailable` on the widened methods. `@awthaq/api` moves from `devDependencies` to `dependencies` (its `ScimApi` imports it). BEH-EA-246.
