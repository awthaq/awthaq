---
"@awthaq/ports": minor
"@awthaq/core": minor
"@awthaq/admin": minor
"@awthaq/api-key": patch
"@awthaq/cli": patch
"@awthaq/device-authorization": patch
"@awthaq/jwt": patch
"@awthaq/magic-link": patch
"@awthaq/oauth": patch
"@awthaq/organization": patch
"@awthaq/passkey": patch
"@awthaq/password": patch
"@awthaq/saml": patch
"@awthaq/scim": patch
"@awthaq/server": patch
"@awthaq/sql": patch
"@awthaq/webhooks": patch
---

`GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.

For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. Two-factor and roles are deployment-scoped by intent; their declaration lands in a follow-up, and `ConfigDescriptor.make` keeps a transitional overload for a bare `Context.Reference` until then.

Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
