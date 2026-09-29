# Multi-Tenancy
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-28 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (DRS-001, EP-001, EP-004, EP-007, DRS-005, EP-003; [ADR-EA-018](../decisions/018-tenancy-is-an-organization.md)) |
---

> A tenant is an `Organization` row ([ADR-EA-018](../decisions/018-tenancy-is-an-organization.md)); everything below is opt-in and zero-cost for a single-tenant deployment.

## BEH-EA-230: The tenant is an ambient reference that defaults to none

```text
REQUIREMENT: `TenantContext` MUST be a `Context.Reference<Option<string>>` whose
             default is `Option.none()`, so a composition that never provides it
             behaves exactly as one written before tenancy existed. It is provided
             per request by `Organization.tenantMiddleware` (BEH-EA-234) or per
             unit of work by `withTenant` / `TenantScope.withTenant`.
```

The reference is defined in `@awthaq/ports` (the persistence stratum reads it and sits below core) and re-exported by `@awthaq/core` as `Tenant`. Its value is an opaque string: core never interprets it and never resolves it to an organization.

_Previous: [BEH-EA-224](27-admin-impersonation.md#beh-ea-224-admin-actions-are-audited-by-events) | Next: [BEH-EA-231](28-tenancy.md#beh-ea-231-every-core-insert-is-stamped-with-the-ambient-tenant)_

## BEH-EA-231: Every core insert is stamped with the ambient tenant

```text
REQUIREMENT: Every repository insert into `users`, `accounts`, `sessions`,
             `verification_tokens`, `verification_reservations` and
             `auth_audit_log` MUST store `"tenantId"` as the input's explicit
             value when non-null, otherwise the ambient `TenantContext`, otherwise
             `NULL`. The column MUST have no JSON variant and no `update`
             variant: a request body cannot name a tenant, and a row is stamped
             once.
```

Stamping happens at the repository, the one place every insert passes through, so no service signature changes and a caller cannot forget it. `UserRecord.tenantId` and `SessionView.tenantId` expose the value; `layerMemory` twins stamp the same fields. Historic rows and single-tenant deployments read back `None`.

_Previous: [BEH-EA-230](28-tenancy.md#beh-ea-230-the-tenant-is-an-ambient-reference-that-defaults-to-none) | Next: [BEH-EA-232](28-tenancy.md#beh-ea-232-the-identity-directory-is-global-across-tenants)_

## BEH-EA-232: The identity directory is global across tenants

```text
REQUIREMENT: `users` and `accounts` MUST remain the global identity directory:
             `lower(email)`, `phone` and `(providerId, subject, issuer)` are
             unique across tenants, and `findByEmail`, `findByPhone` and
             `findByProviderSubject` MUST NOT take a tenant predicate. Tenant
             routing applies to sessions, verification tokens and reservations,
             and the audit log.
```

One person may belong to many organizations, and sign-in resolves an identity before a tenant is known. Under sharding the directory stays unsharded (or replicated read-only); the tenant-stamped tables are what partition.

_Previous: [BEH-EA-231](28-tenancy.md#beh-ea-231-every-core-insert-is-stamped-with-the-ambient-tenant) | Next: [BEH-EA-233](28-tenancy.md#beh-ea-233-postgres-row-level-security-is-an-opt-in-fail-closed-backstop-inside-a-tenant-scope)_

## BEH-EA-233: Postgres row-level security is an opt-in, fail-closed backstop inside a tenant scope

```text
REQUIREMENT: `TenantScope.enableRls()` MUST enable and force a row-level-security
             policy on the partitioned tables, idempotently and as a no-op off
             Postgres. Inside `TenantScope.withTenant(id)`, a read MUST NOT see,
             and a write MUST NOT touch or create, a row whose `"tenantId"`
             differs from `id`. With no tenant set the policy MUST admit every
             row (single-tenant deployments and maintenance keep working).
```

`withTenant` opens (or nests into) one transaction and sets the transaction-local `awthaq.tenant_id`, so a pooled connection never leaks a tenant to the next request. RLS covers `users`/`accounts` only through `enableRls({ includeDirectory: true })`. It is defence in depth ([ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md)), bypassed by superusers, `BYPASSRLS` roles and, absent `FORCE`, the table owner.

_Previous: [BEH-EA-232](28-tenancy.md#beh-ea-232-the-identity-directory-is-global-across-tenants) | Next: [BEH-EA-234](28-tenancy.md#beh-ea-234-the-tenant-middleware-resolves-the-organization-once-per-request)_

## BEH-EA-234: The tenant middleware resolves the organization once per request

```text
REQUIREMENT: `Organization.tenantMiddleware` MUST call the application-provided
             `TenantResolver` once per request and, when it yields an
             organization id, provide `TenantContext` for the rest of that
             request's fiber; when it yields none, the request runs with no
             tenant. A resolver id naming no organization MUST be refused, not
             silently run untenanted.
```

The resolver is a port the application provides ([ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)); awthaq ships no routing convention. An application that does not wire the middleware is unchanged.

_Previous: [BEH-EA-233](28-tenancy.md#beh-ea-233-postgres-row-level-security-is-an-opt-in-fail-closed-backstop-inside-a-tenant-scope) | Next: [BEH-EA-235](28-tenancy.md#beh-ea-235-organization-oauth-connections-are-consulted-after-the-static-registry)_

## BEH-EA-235: Organization OAuth connections are consulted after the static registry

```text
REQUIREMENT: `OAuth.authorize` and `OAuth.callback` MUST resolve a provider id
             from the static registry first and only on a miss consult the
             installed connection resolver; a connection's provider id is
             namespaced `org:<organizationId>:<connectionId>` so it can never
             shadow a static provider. A connection's client secret MUST be
             ciphertext at rest.
```

The resolver is a port-shaped callback so `@awthaq/oauth` never imports the organization plugin. Home-realm discovery passes an `organization` id or the sign-in email's domain as the hint. Role mapping stays in qadi.

_Previous: [BEH-EA-234](28-tenancy.md#beh-ea-234-the-tenant-middleware-resolves-the-organization-once-per-request) | Next: [BEH-EA-236](28-tenancy.md#beh-ea-236-per-tenant-configuration-applies-per-request-without-changing-the-plugin-tuple)_

## BEH-EA-236: Per-tenant configuration applies per request without changing the plugin tuple

```text
REQUIREMENT: A plugin that supports per-tenant configuration MUST decide its
             configuration per operation: a configuration reference provided in the
             *calling fiber* (a per-request `provideService`, or the tenant
             middleware's `TenantConfig` layers) overrides for that operation, and
             with none provided the build-time value applies exactly as before, so
             `Layer.provide(Plugin.config(...))` keeps its meaning. Two tenants with
             different configuration MUST be servable by one composition.
```

`TenantConfig` is the application's own `LayerMap.Service` keyed by tenant id ([ADR-EA-005](../decisions/005-static-composition.md)'s reserved seam) whose `lookup` returns that tenant's `config(...)` layers merged with `Tenant.configApplied(tenantId)` — a configuration layer alone provides only a `Context.Reference`, a `Layer<never>`, which `LayerMap`'s constructors do not accept, and the marker gives the lookup a real output and lets a handler read which tenant's configuration is in force. `Organization.tenantMiddlewareWithConfig(TenantConfig)` provides those layers for the request. Every configurable plugin adopts the per-operation rule through `Tenant.configInForce(reference, built)`: organization, password, sessions, oauth, passkey, jwt and admin. Values a plugin derives once at boot from its built configuration (Password's rate-limit rules, identifier-digest key and calibrated timing floor; OAuth's `baseUrl`, native redirect list and provider registry; Jwt's signing-key ring) stay boot-scoped and are the deployment's, not the tenant's.

_Previous: [BEH-EA-235](28-tenancy.md#beh-ea-235-organization-oauth-connections-are-consulted-after-the-static-registry) | Next: [BEH-EA-237](28-tenancy.md#beh-ea-237-a-suspended-organization-refuses-organization-scoped-access)_

## BEH-EA-237: A suspended organization refuses organization-scoped access

```text
REQUIREMENT: An organization with `suspendedAt` set MUST refuse every
             organization-scoped operation of the organization plugin —
             members and outsiders alike — with the same `OrganizationNotFound`
             an unknown id gets (MTI-009: a denial never reveals a tenant), MUST
             not become or remain a member's active organization, and MUST
             confer no qadi relationship (`member`, `has-role:*`,
             `<resource>:<action>`, `team-member`, `team-role:*`) through its
             memberships. The member's own `list` MUST still return it,
             flagged `suspended`. Suspension and reinstatement are performed
             only by `AdminTenants` (`Auth.make([Organization, Admin,
             AdminTenants])`), gated by `canAdministerTenants` (fail-closed by
             default, gate before existence), published as
             `auth.admin.organizationSuspended` / `organizationUnsuspended`.
```

Suspension is reversible and never a deletion: every row stays, and reinstating restores access exactly as it was. Using the existing not-found error rather than a new typed one keeps every endpoint's error contract unchanged; the suspended flag on the member's own listing is how a member learns why.

Impersonation records are stamped with the ambient tenant and confined to it unless the caller passes `canAdministerTenants` ([BEH-EA-215](27-admin-impersonation.md#beh-ea-215-admin_impersonation-is-a-durable-audit-trail), [BEH-EA-217](27-admin-impersonation.md#beh-ea-217-forcestop-lets-another-admin-end-someone-elses-impersonation), [BEH-EA-219](27-admin-impersonation.md#beh-ea-219-the-audit-trail-is-queryable)).

_Previous: [BEH-EA-236](28-tenancy.md#beh-ea-236-per-tenant-configuration-applies-per-request-without-changing-the-plugin-tuple) | Next: [BEH-EA-238](29-saml-sp.md#beh-ea-238-the-saml-response-is-size-capped-before-it-is-parsed)_
