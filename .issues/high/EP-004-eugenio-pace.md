---
ID: "EP-004"
Title: "Connection model absent: OAuth providers are a static per-composition array"
Level: high
Category: "architecture"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:47"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-004 — Connection model absent: OAuth providers are a static per-composition array

`HIGH` · `architecture` · `oauth` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

Auth0's core abstraction — connections configured per tenant, resolved per request — has no counterpart. Providers live in `OAuthConfigShape.providers`, resolved once at plugin-make time into a process-global registry Map (OAuth.ts:445-448). The spec says it outright for the planned SSO plugin: 'There is no `SsoApi` contract, no connection model, no per-tenant resolution mechanism' (spec/models/09-sso.md:65). Enterprise SSO (per-org SAML/OIDC with org-scoped client ids/secrets stored in the database) is the feature B2B customers pay for, and nothing here can host it yet.

## Evidence

Source: `packages/oauth/src/OAuth.ts:47`

```
export interface OAuthConfigShape {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
```

## Recommended fix

Land the sketched `SsoConnectionResolver` port (spec/models/09-sso.md:43): a connection table (org-scoped provider config, secrets via the existing KeyProvider encryption) plus per-request resolution ahead of the shared OAuth flow, so the connection model arrives as data, not as another composition-time array.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/oauth/src/OAuth.ts:47-48` exactly; providers are resolved once at boot into a closure-scoped `Map` (`OAuth.ts:445-448`), and `spec/models/09-sso.md` confirms verbatim: "There is no `SsoApi` contract, no connection model, no per-tenant resolution mechanism." The spec itself flags this as an undesigned, blocked area — landing a per-tenant connection resolver is an architecture decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Multi-tenant composition model, per-org OAuth connections & tenant/shard key schema](../../.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md) — Resolved via the same per-organization `OrganizationConnections`/`LayerMap` design described in the ticket, landing the connection model as data rather than another composition-time array. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `multi-tenant-oauth-connections`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:56`. Fix: Implement ticket 18's connection model: an org-owned connection table plus a LayerMap-backed resolver, consulted after the static registry. (effort XL). Full dossier: `.plan/slices/03-oauth-flow.md`.

**Resolved (2026-09-29):** Per-organization OAuth connections landed (ADR-EA-018, BEH-EA-235). @awthaq/oauth: OAuthConnections.ts (Context.Reference resolver port, default none; the resolver returns a provider CONFIG plus a revision so discovery, deadlines, retries and the issuer-mismatch defect stay oauth-owned), OAuthProviders consults it after the static registry (static ids always win; connection discovery resolved lazily, cached per revision for an hour, never cached on failure; an invalid or unreachable connection answers ProviderUnavailable, never a runtime defect); OAuthProviders.has is now an Effect. @awthaq/organization: organization plugin migration for organization_oauth_connection and organization_oauth_connection_domain (domain UNIQUE, so one email domain routes to one connection across organizations), ConnectionRecords (memory + SQL), OrganizationConnections LayerMap.Service keyed by organization id (decrypts secrets, idle TTL, invalidated on every write) with oauthConnections installing the resolver, OrganizationConnectionStore (create/update/remove/list + discover for home-realm routing by organization id or email domain; secret sealed with Encryption AAD organization-oauth-connection:<id>:clientSecret and never returned; https-only, no credentials, no private/loopback hosts as an SSRF floor), cleanupOnOrganizationDelete opt-in layer. The provider id is org:<organizationId>:<connectionId>. Tests: oauth "EP-004" suite (a connection id completes a full callback, static wins over a same-id connection, unknown id, no resolver installed, discovery cached per revision and refetched on change, unreachable discovery is 503 and retried, issuer mismatch refused), ConnectionRecords contract (memory, SQL, Postgres), OrganizationConnections (ciphertext at rest, SSRF validation, domain uniqueness, discover, LayerMap cache and invalidation, undecryptable secret drops only that connection, cleanup hook) and an end-to-end organization -> oauth sign-in. Deferred (own follow-ups, not blockers): HTTP CRUD for connections (belongs to ticket 19 admin surface; needs a connection statement in PermissionEngine), DNS-proof verification of email domains, SAML kind (reserved by the ADR).
