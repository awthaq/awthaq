---
ID: "PDR-005"
Title: "Insecure-by-default OAuth/passkey origins: localhost baseUrl and empty trustedOrigins ship as defaults"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:62"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-005 — Insecure-by-default OAuth/passkey origins: localhost baseUrl and empty trustedOrigins ship as defaults

`LOW` · `security` · `oauth` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **resolved**

## Summary

OAuthConfig defaults to baseUrl http://localhost:3000 with an empty trustedOrigins allowlist, and PasskeyConfig mirrors the posture (rpId localhost, origins [http://localhost:3000]) — both self-documented as deliberate dev defaults expected to be overridden. The mitigating design is real: redirect_uri is always derived from baseUrl (never request input), so a misconfigured production deploy fails closed — sign-in sends users to a localhost redirect_uri the provider will reject. Residual risk is silent misconfiguration (a prod deployment that never calls config() gets confusing failures rather than a boot-time refusal) and, for WebAuthn, an rpId/origins pair that simply will not match production origins, failing credential creation.

## Evidence

Source: `packages/oauth/src/OAuth.ts:62`

```
trustedOrigins: [],
  baseUrl: "http://localhost:3000",
  defaultCallbackURL: "/",
```

## Recommended fix

Fail composition at boot when baseUrl/rpId/origins still equal the localhost defaults in a non-dev environment (NODE_ENV/production detection), or make baseUrl a required config like JwtConfig.issuer already is — that module's own header comment articulates exactly the stricter precedent.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Web attack surface
- Full dossier: [`philippe-de-ryck`](../../.reports/philippe-de-ryck/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-config-safety`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:67`. Fix: Make baseUrl required (JwtConfig's precedent) and validate it at boot. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OAuthConfig is now a plain Context.Service (JwtConfig precedent) with no default; OAuth.config({ baseUrl, ...}) requires baseUrl (OAuthConfigInput.baseUrl is non-optional) so composing OAuth without it fails to type-check (@ts-expect-error test on OAuth.config({})). OAuth.make validates baseUrl at boot (URL parse, http/https, no path/query/fragment/credentials -> die naming baseUrl), warns on plain http non-loopback, and derives redirect_uri from the origin (a trailing slash no longer doubles). OAuthTokenAccess.layer's annotated requirement gains OAuthConfig. Callers (packages/oauth tests, features OAuthWorld) already passed baseUrl. BEH-EA-128 amended. Tests: path-component baseUrl dies (red before: booted), unparseable baseUrl dies, http non-localhost warns, localhost http silent, trailing slash normalized. AGA-005's boot log of each effective redirect_uri is included (its README half lands with the docs commit). Gates: tsc -b, tsconfig.test.json, vitest 889 pass, test:bdd 106, spec:verify:strict, oxlint.
