---
ID: "EEM-007"
Title: "AccountExists wire error hardcodes provider 'password' regardless of the conflicting account's actual strategy"
Level: low
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:691"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-007 — AccountExists wire error hardcodes provider 'password' regardless of the conflicting account's actual strategy

`LOW` · `api` · `oauth` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **resolved**

## Summary

Both AccountExists raise sites (lines 655 and 691) pass Accounts.PASSWORD_PROVIDER_ID, but the conflict is with a users row that may have been created by passkey or another plugin (the lookup is users.findByEmail at line 648, before any password credential is consulted). The typed payload therefore asserts a fact the code did not verify — a consumer building UX like 'sign in with your password instead' is misled for passkey-only users. Since the schema carries the field per-member, keeping it honest is free.

## Evidence

Source: `packages/oauth/src/OAuth.ts:691`

```
new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
```

## Recommended fix

Either drop the provider field from AccountExists (empty payload like the other uniform errors) or populate it from the actually-found account's provider(s).

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-account-linking-policy`. Duplicate of `NAM-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:798`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
