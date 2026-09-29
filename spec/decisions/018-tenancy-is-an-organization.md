# ADR-EA-018: A Tenant Is an Organization Row; Core Carries an Opaque, Ambient Tenant Column

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-018 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (DRS-001, EP-001, DRS-005, SAM-006, CSG-009; wayfinder ticket 18) |

---

## Context

[ADR-EA-005](005-static-composition.md) fixes the plugin tuple at composition time and says everything that must vary at runtime — per-tenant configuration, per-request provider selection — is expressed *inside* an installed plugin through `Config`, `Context.Reference` ([ADR-EA-011](011-configuration-service-with-default.md)) or `LayerMap.Service`. It never said what a *tenant* is, so a multi-tenant deployment had nowhere to attach: no table carried a tenant key (DRS-001), the OAuth provider list was a static array (EP-004), and "one static composition per process" was the only deployment shape (EP-001). Wayfinder ticket 18 resolved the fork EP-001 posed — tenant as an organization row, or host-per-tenant deployments — and this record makes that decision normative and records where the implementation deliberately departs from the ticket's wording.

## Decision

**1. A tenant is an `Organization` row.** No new "Tenant" concept and no new plugin. Host-per-tenant redeploys (a different plugin tuple per tenant) are rejected: that is exactly what ADR-EA-005 forbids.

**2. Core carries an opaque tenant key, never a foreign key.** Plugins depend on core, never the reverse, so a core table cannot reference `organization_org`. Every core table that holds per-request or per-user data has a nullable, indexed `"tenantId" TEXT` column (migrations 24–25: `users`, `accounts`, `sessions`, `verification_tokens`, `verification_reservations`, `auth_audit_log`). The value is app-interpreted. `NULL` means "no tenant" and is what a single-tenant deployment always writes; there is no backfill.

- The column is spelled `"tenantId"`, not the ticket's `tenant_id`: every column in this schema is quoted camelCase.
- It is a database-variant field only. No JSON variant carries it, so a request body can never name its own tenant, and it has no `update` variant: a row is stamped once, at insert.
- Indexes: `("tenantId", "userId")` on `sessions` and `verification_tokens` (the leading column also serves a tenant-only predicate, so no separate single-column index), and `"tenantId"` alone on the rest.

**3. The tenant is ambient, not a parameter.** `TenantContext` is a `Context.Reference<Option<string>>` with default `Option.none()` (the `SessionConfig` shape, ADR-EA-011). It is *defined* in `@awthaq/ports` and re-exported as `Tenant` from `@awthaq/core`: `@awthaq/sql` sits below core and its repositories are the one choke point every insert passes through, so they must be able to read it. Every repository insert stamps `input.tenantId ?? TenantContext ?? NULL` — an explicit value wins, then the ambient one. No core service signature changes, and nothing has to provide the reference: an unprovided read is `None`. `withTenant(id)` / `withoutTenant` scope it for jobs and tests. `UserRecord.tenantId` and `SessionView.tenantId` expose the attribution so a host can, for example, refuse a session cookie minted for another tenant.

**4. The identity directory is global (DRS-005, option A).** `users` and `accounts` are the global identity directory: `lower(email)`, `phone` and `(providerId, subject, issuer)` stay unique *across* tenants, and the sign-in lookups (`findByEmail`, `findByProviderSubject`) take no tenant predicate. This matches "tenant = organization" — one person belongs to many organizations — and sign-in resolves an identity before any tenant is known. Tenant-scoped routing applies to the tables that partition: sessions, verification tokens/reservations and the audit log. Under sharding the directory stays unsharded (or replicated read-only) and those tables are what split. Option B (per-tenant uniqueness through tenant-prefixed unique indexes) was not adopted: it makes "the same person in two organizations" two unrelated users.

**5. Structural isolation on Postgres is opt-in (`TenantScope`).** `TenantScope.enableRls()` enables *and forces* a row-level-security policy on the partitioned tables; `TenantScope.withTenant(id)` runs an effect with the ambient tenant provided and, on Postgres, inside one transaction whose first statement is `set_config('awthaq.tenant_id', id, true)` (transaction-local, so pool-safe). Inside that scope a forgotten application filter, a cross-tenant update and a forged cross-tenant insert all fail closed at the database. SQLite has no RLS: `withTenant` only provides the ambient tenant, and WHERE-discipline is its whole enforcement — an accepted, backend-specific gap for a typically embedded, single-tenant backend.

Two deliberate departures from the ticket's sketch:

- RLS is enabled by an idempotent `enableRls` / `disableRls` pair, **not** by numbered migrations. `CoreMigrations` ids are a forward-only ledger that every deployment must apply in order; RLS is an operator's choice that must be reversible, and a numbered migration would have either forced it on everyone or blocked later ids behind a skipped one.
- The policy is fail-open when *no* tenant is set (`awthaq.tenant_id` unset or empty), as the ticket specified, so a single-tenant deployment, a migration and a maintenance script keep working with RLS on. The guarantee is: *work that runs inside `withTenant` is confined to its tenant.* `users`/`accounts` are covered only by `enableRls({ includeDirectory: true })`, for a deployment that routes every read through `withTenant`.

RLS is defence in depth, not the primary authorization control ([ADR-EA-009](009-authorization-delegated-to-qadi.md)). It is bypassed by superusers, `BYPASSRLS` roles and — absent `FORCE`, which `enableRls` sets — the table owner; the application should connect as a plain non-owner role.

**6. Tenant resolution is an application port; the middleware is opt-in.** `@awthaq/organization` declares a `TenantResolver` port, `(request) => Effect<Option<OrganizationId>>`, provided by the application (subdomain, path segment, header, custom domain — awthaq invents no routing convention, [ADR-EA-010](010-plugins-require-ports-never-provide.md)). `Organization.tenantMiddleware` resolves it once per request and provides `TenantContext` — and, when installed, the tenant's configuration — for the rest of the request's fiber. An application that never wires it sees `None` everywhere.

**7. Per-organization OAuth connections are data.** `@awthaq/organization` owns `organization_oauth_connection` (client secret encrypted through the existing `Encryption`/`KeyProvider` ports), and `OrganizationConnections` is a `LayerMap.Service` keyed by organization id that builds an `OAuthProvider` from a stored row with the same `OAuthProvider.resolve` the static providers use. `@awthaq/oauth` consults the static registry first, then a port-shaped `connections` resolver, so it never imports the organization plugin. Role and entitlement mapping stays in qadi (ADR-EA-009).

**8. Per-tenant configuration** follows ADR-EA-005/006. A plugin decides its `Context.Reference` config per operation rather than once at layer build: a value provided in the *calling fiber* overrides for that operation, and with none provided the build-time value applies — a hybrid, because a plain per-operation read would silently ignore every `Layer.provide(Plugin.config(...))` (the composition idiom, which puts the config in the layer-build context only, not the request's). An application-defined `TenantConfig` `LayerMap.Service` keyed by tenant id supplies each tenant's configuration layers (merged with `Tenant.configApplied(tenantId)`, which gives `LayerMap` the non-`never` output its constructors require), and `Organization.tenantMiddlewareWithConfig` provides them per request. `@awthaq/organization` adopts the rule now; the other plugins follow (EP-007 stays open for them).

**9. Organization-level tenancy fields** are the plugin's own: a config-validated `homeRegion` (`OrganizationConfig.regions` is the residency vocabulary; the organization→shard mapping is data, `homeRegionOf(record)` the pure helper — DRS-007), per-organization quota overrides with a finite default `organizationLimit` (EP-006), invitations conferring membership only on a verified address by default (EP-010), and organization suspension as the superadmin tenant-administration primitive (EP-003).

## Alternatives considered

**Host-per-tenant deployments** — rejected (Decision 1). **A real foreign key from core tables to `organization_org`** — impossible under the stratum rule. **Threading a `tenantId` through every service method** — a breaking signature change on every core service and trivially forgotten; the ambient reference is both zero-cost for the single-tenant default and un-forgettable at the repository choke point. **A per-tenant uniqueness scope** (DRS-005 option B) — see Decision 4. **RLS as numbered core migrations** — see Decision 5.

## Consequences

**Positive**: a single-tenant deployment is byte-for-byte unchanged (every `"tenantId"` is `NULL`, nothing provides the reference); a multi-tenant deployment gets attribution on every row, a per-request tenant, per-organization connections and configuration, and an optional database-enforced isolation boundary — all inside the plugin tuple ADR-EA-005 requires.

**Negative**: the column is attribution, not enforcement, until RLS is enabled and the application runs as a non-owner role; SQLite deployments have no structural backstop. `withTenant` costs a transaction per scoped unit of work on Postgres. Rows written before tenancy was adopted carry `NULL` and are invisible to a tenant scope once RLS is on, so a deployment adopting RLS backfills first.

**Trade-off accepted**: users and accounts are global, so a tenant cannot have its own private namespace of emails. That is the price of "one person, many organizations", and the directory stays the one thing sharding cannot split.

Implemented: `packages/ports/src/Tenant.ts`, `packages/core/src/Tenant.ts`, `packages/sql/src/{CoreMigrations,Models,Repositories,TenantScope}.ts`, and the organization/OAuth pieces named above. Behaviors: [BEH-EA-225](../behaviors/28-tenancy.md#beh-ea-225-the-tenant-is-an-ambient-reference-that-defaults-to-none) through BEH-EA-232. Data-location guidance for deployers is in `packages/sql/README.md`, "Data location & residency".
