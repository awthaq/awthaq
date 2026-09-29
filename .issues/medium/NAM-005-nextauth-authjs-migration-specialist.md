---
ID: "NAM-005"
Title: "Auto-linking is stricter than Auth.js — silent behavior change for migrated users"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:651"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-005 — Auto-linking is stricter than Auth.js — silent behavior change for migrated users

`MEDIUM` · `security` · `oauth` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

As a security posture this is good: both conditions (plugin-level trustedProviders list AND a verified email claim) must hold, whereas Auth.js's `allowDangerousEmailAccountLinking: true` links on email match regardless of verification status. For migration it is a behavioral break: users who were auto-linked in Auth.js with an unverified provider email will, after migration, start receiving AccountExists on sign-in with their existing account — a support-generating regression that surfaces only for affected users, not at deploy time. The model is also plugin-level rather than per-provider: an Auth.js app that enabled the flag on exactly one of three providers must now express that via the trustedProviders list, which is a faithful mapping but undocumented.

## Evidence

Source: `packages/oauth/src/OAuth.ts:651`

```
const autoLink =
  trustedProviders.includes(providerId) && profile.emailVerified === true;
```

## Recommended fix

Keep the stricter default but document the mapping (Auth.js per-provider flag → trustedProviders entry) in a migration guide, and consider surfacing AccountExists with the actually-owning provider so apps can distinguish 'password account exists' from 'another OAuth provider exists' (see NAM-006).

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-account-linking-policy`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:762`. Fix: Document the Auth.js to awthaq linking mapping. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/oauth/README.md rewritten from the 'planned package' stub: 'Migrating from Auth.js' maps allowDangerousEmailAccountLinking on provider x to linking { trustedProviders: ['x'] }, states awthaq additionally requires provider email_verified and (TMS-007) a verified local email, and that affected users see AccountExists and must sign in then link; plus an Auth.js provider-id to preset table. Docs only.
