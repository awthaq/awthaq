---
ID: "AOMS-007"
Title: "Federated users are created with emailVerified=false even when the IdP verified the email"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:686"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-007 — Federated users are created with emailVerified=false even when the IdP verified the email

`MEDIUM` · `correctness` · `oauth` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

Users.create always starts emailVerified false and only verifyEmail transitions it (packages/core/src/Users.ts:49-53), so an Okta/Auth0-verified email never reaches the durable record — the auto-link check at OAuth.ts:652 reads the transient profile claim, not stored state. A migrated user whose federation is later removed falls back to password sign-in, where the EmailNotVerified gate (packages/password/src/Password.ts, checked only after correct password) forces a re-verification email for an address the enterprise IdP had already proven. This is exactly the 'two divergent sources of truth' failure mode a phased cutover is supposed to eliminate.

## Evidence

Source: `packages/oauth/src/OAuth.ts:686`

```
                    const user = yield* users
                      .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
```

## Recommended fix

Either accept a trusted-provider emailVerified input on create for federation (scoped to providers configured as trusted, keeping the supplier-authority rule for the password plugin), or have the OAuth plugin call users.verifyEmail when profile.emailVerified is true at first creation.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-account-linking-policy`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:798`. Fix: When a trusted provider asserts email_verified at first (JIT) creation, mark the new local user verified inside the same transaction. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** JIT creation branch: inside the same withTransaction, after users.create, users.verifyEmail(user.id) when profile.email is present AND profile.emailVerified === true AND the provider is in trustedProviders (orDie: UserNotFound is impossible inside the transaction). Not called on auto-link/explicit-link paths and never for untrusted providers. Tests: trusted+verified -> verified user (red before), untrusted+verified -> unverified, trusted but unasserted -> unverified. BEH-EA-124 and BEH-EA-042 (06-domain-users-accounts.md, sanctioned caller note) amended. Gates as TMS-007.
