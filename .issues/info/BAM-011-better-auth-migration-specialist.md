---
ID: "BAM-011"
Title: "Account linking is at parity and the identity anchor is stricter than better-auth's"
Level: info
Category: "architecture"
Status: needs-triage
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:50"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-011 — Account linking is at parity and the identity anchor is stricter than better-auth's

`INFO` · `architecture` · `oauth` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **needs-triage**

## Summary

better-auth's research docs admit its (providerId, accountId) uniqueness is application-discipline rather than a database constraint; effect-auth enforces UNIQUE(providerId, subject, issuer) in DDL (CoreMigrations.ts:93), folds issuer into the key to stop OIDC cross-issuer reunification (BEH-EA-125), defaults linking to explicit, and gates trusted-provider auto-link on provider-verified email — matching or tightening better-auth's accountLinking semantics. Migration maps (providerId, accountId) rows 1:1 with issuer=''. This is the strongest parity area found.

## Evidence

Source: `packages/oauth/src/OAuth.ts:50`

```
  readonly linking: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
```

## Recommended fix

No action for parity; use this table as the template for the import command's account-mapping step, including the password-credential row (providerId 'credential' → PASSWORD_PROVIDER_ID 'password' with the digest re-serialized per BAM-004).

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `oauth-account-linking-policy`. Evidence at HEAD ec065a7: `packages/sql/src/CoreMigrations.ts:93`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/03-oauth-flow.md`.
