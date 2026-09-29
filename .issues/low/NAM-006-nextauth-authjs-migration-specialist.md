---
ID: "NAM-006"
Title: "AccountExists always reports the conflicting provider as 'password'"
Level: low
Category: "correctness"
Status: ready-for-human
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:655"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-006 — AccountExists always reports the conflicting provider as 'password'

`LOW` · `correctness` · `oauth` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **ready-for-human**

## Summary

Both collision paths hardcode `provider: PASSWORD_PROVIDER_ID`: the auto-link rejection (line 655) fires whenever the email exists under ANY account — including a different OAuth provider — and the EmailAlreadyExists translation in the create path (line 691) repeats it. A client (or migration tooling reconciling Auth.js account data) cannot distinguish 'this email has a password credential' from 'this email belongs to another OAuth provider', and the error's provider field is factually wrong in the second case. Auth.js's equivalent OAuthAccountNotLinked is at least provider-neutral instead of misleading.

## Evidence

Source: `packages/oauth/src/OAuth.ts:655`

```
return yield* Effect.fail(
  new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
);
```

## Recommended fix

Look up the existing accounts for the colliding user and report the real owning providerId(s), or omit the field; at minimum stop asserting the password provider when no password credential was consulted.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-account-linking-policy`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:762`. Fix: Report the actually-linked providers (or nothing), never a hardcoded 'password'. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-human.
