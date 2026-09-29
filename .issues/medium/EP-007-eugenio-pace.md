---
ID: "EP-007"
Title: "Per-tenant configuration mechanism designed but unimplemented"
Level: medium
Category: "architecture"
Status: resolved
Package: "—"
Source: "spec/decisions/005-static-composition.md:39"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-007 — Per-tenant configuration mechanism designed but unimplemented

`MEDIUM` · `architecture` · `—` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

ADRs 005/006/011 consistently name the tenancy mechanism: `LayerMap.Service` composing per-tenant `Password.config(...)`/`Sessions.config(...)` Layers over the same `Context.Reference` (spec/decisions/006-runtime-config-separate-from-installation.md:31: 'multi-tenant configuration is `LayerMap` composed over the same `Context.Reference`'). A grep confirms `LayerMap` exists nowhere in packages/ — it lives only in spec text and the v4 substrate rationale. The design is the right one (no contract change needed), but today there is exactly one configuration reality per process, which caps the platform at one tenant.

## Evidence

Source: `spec/decisions/005-static-composition.md:39`

```
Not yet implemented — see spec/roadmap.md for milestone.
```

## Recommended fix

Promote the LayerMap per-tenant path from roadmap to a tracked milestone with an integration test proving two tenants with different `Password.config({ minLength })` in one composition — it is the cheapest credible demonstration that the tenancy claim is more than prose.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EP-001` — No tenant model exists; one static composition per process is the only deployment shape](high/EP-001-eugenio-pace.md) `_(eugenio-pace, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `multi-tenant-composition`. Evidence at HEAD ec065a7: `spec/decisions/005-static-composition.md:39`. Fix: Make per-tenant configuration real: plugins read their config Reference per operation (not once at Layer build), and a `TenantConfig` LayerMap.Service keyed by tenant id supplies each tenant's config Layers, provided per request by the tenant middleware — ADR-005/006's own prescription. (effort L). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Plan note (2026-09-29, P18):** partially landed, left open. DONE: the mechanism and the organization plugin. Organization now decides its configuration per operation (a value provided in the calling fiber overrides; with none, the build-time Organization.config applies, so Layer.provide(Organization.config(...)) keeps working - a plain per-operation read would have silently ignored every such config, which is why the dossier step 1 was adapted to this hybrid); Tenant.configApplied in @awthaq/ports (a config layer is only a Layer<never>, which LayerMap constructors reject, so a tenant lookup merges this marker in); Organization.tenantMiddlewareWithConfig / WithConfigAndRls provide an application-defined TenantConfig LayerMap.Service per request. Tests: two tenants with different membership limits and invitation policy in one composition on the same layer instance, build-time config unchanged with no override, and the middleware over real HTTP providing each tenant its own config. Decision recorded in ADR-EA-018 Decision 8 and BEH-EA-236. REMAINING (the dossier acceptance is not yet met - every plugin capturing config at build): password (owned by P07; besides minLength/breach policy it derives rate-limit rules and the sign-in timing floor at boot, which need a per-tenant treatment of their own), core Sessions/SessionConfig, oauth, passkey, jwt, admin. Each adopts the same one-line configNow pattern; the dossier first failing test (Password two tenants, minLength 8 vs 16) is the next slice.

**Resolved (2026-09-29):** Per-tenant configuration extended from Organization to every configurable plugin. Tenant.configInForce(key, built) in @awthaq/ports (re-exported as core Tenant.configInForce) is the one-line hybrid read (calling-fiber override else build-time value, so Layer.provide(Plugin.config(...)) is unchanged). Adopted in Password (policy, requireVerifiedEmail, resetTtl, links, signUpEnumeration, sign-in timing floor; rate-limit rules/digest key/calibration stay boot-scoped), core Sessions layerMemory/layerSql (absolute/idle/touchEvery/maxConcurrent), OAuth + OAuthTokenAccess (trusted origins, default callback, linking, timeouts, skew, exchange ttl, rate-limit budgets; baseUrl/providers/native redirects boot-scoped), Passkey (rpId, origins, attestation, UV, counter policy, reauth window; boot validation + decoy secret boot-scoped), Jwt (issuer/audience/ttl/definePayload/mirroring/jwks cache lifetime; key ring boot-scoped), Admin + AdminTenants (all gates, maxDuration). Tests (each two tenants on one layer instance + default path unchanged; red proven by reverting the source for Password and Sessions): packages/password/test/PasswordTenantConfig.test.ts, packages/core/test/Sessions.test.ts (EP-007 x2, memory+SQL), packages/oauth/test/OAuthTenantConfig.test.ts, packages/passkey/test/PasskeyTenantConfig.test.ts, packages/jwt/test/JwtTenantConfig.test.ts, packages/admin/test/AdminTenantConfig.test.ts. ADR-EA-018 rev 1.1 Decision 8 and BEH-EA-236 updated. Gates: typecheck clean, 1512 tests in core/password/oauth/passkey/jwt/admin/organization, spec:verify:strict pass.
