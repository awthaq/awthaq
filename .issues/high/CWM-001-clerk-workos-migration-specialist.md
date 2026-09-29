---
ID: "CWM-001"
Title: "OAuth providers are a static compose-time array — a WorkOS connection-per-organization model is unrepresentable without a redeploy"
Level: high
Category: "architecture"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:48"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-001 — OAuth providers are a static compose-time array — a WorkOS connection-per-organization model is unrepresentable without a redeploy

`HIGH` · `architecture` · `oauth` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

WorkOS's core model is a connection scoped to one enterprise customer, registered at runtime and routed by the sign-in email's domain; Clerk's B2B SSO add-on is the same shape. Here providers are a compile-time config list (packages/oauth/src/OAuth.ts:48) resolved exactly once at plugin boot into an immutable registry Map (lines 445-448: `Effect.all(config_.providers.map((provider) => OAuthProvider.resolve(httpClient, provider)))` then `new Map(resolved.map(...))`); `authorize` looks up by provider id only, with no organization binding, no email-domain routing, and no runtime registration path. The documented 'a real deployment builds google/github/apple by calling oidc/oauth2' recipe (packages/oauth/src/OAuthProvider.ts:9-11) covers consumer social providers, not enterprise multi-tenancy. A migration off WorkOS SSO therefore has no landing surface today; the Sso/Saml packages are Planned-Phase3, but the runtime connection-registry seam is the piece that cannot be retrofitted cheaply later.

## Evidence

Source: `packages/oauth/src/OAuth.ts:48`

```
export interface OAuthConfigShape {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
```

## Recommended fix

Design the tenant-connection seam now, before Phase 3 SSO starts: a ConnectionRecord (id, organizationId, kind, issuer/endpoints, client credentials, domain claims) owned by the organization plugin's tables, resolved per sign-in by email domain, with the provider registry keyed on it instead of boot-time config. Keep connection-derived role/entitlement mapping out of the table and in qadi, per the project's own delegation decision. Even a spec-level contract (spec/models/09-sso.md already depends on organization) unblocks the migration story.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts:47-48` declares `providers: ReadonlyArray<...>` as static config; `authorize` (line 453) resolves providers only via `registry.get(providerId)`, and the registry is built once at boot from `Effect.all(config_.providers.map(...))` into an immutable `Map`, with no organization/domain-scoped lookup or runtime registration path anywhere in the file. Designing the tenant-connection seam is an architecture decision, not a mechanical change. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Multi-tenant composition model, per-org OAuth connections & tenant/shard key schema](../../.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md) — Resolved via a new `organization_oauth_connection` table and a `LayerMap.Service`-backed `OrganizationConnections` port, resolved per-request alongside (not replacing) the existing static provider `Map`; connection-derived roles stay in qadi per `ADR-EA-009`. Status → ready-for-agent.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `multi-tenant-oauth-connections`. Duplicate of `EP-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:56`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
