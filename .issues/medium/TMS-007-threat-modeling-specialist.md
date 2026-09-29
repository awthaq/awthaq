---
ID: "TMS-007"
Title: "Trusted-provider auto-link ignores the local account's emailVerified — email-squatting account pre-takeover"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:651"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-007 — Trusted-provider auto-link ignores the local account's emailVerified — email-squatting account pre-takeover

`MEDIUM` · `security` · `oauth` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

Auto-link requires the provider-side email to be verified but never checks existing.value.emailVerified on the matched local user. signUp creates accounts with emailVerified=false and no mailbox proof (Users.ts:50, Password.ts:481), so an attacker can squat victim@example.com locally with a password they know; when the real mailbox owner later signs in via a trusted provider (their provider email is legitimately verified), they are silently linked into the attacker's squatted account — which the attacker can still access via the password they chose, and whose identity/reputation now belongs to the victim. The provider-verified check is correct as far as it goes; it just verifies the wrong side of the link.

## Evidence

Source: `packages/oauth/src/OAuth.ts:651`

```
                const autoLink =
                  trustedProviders.includes(providerId) && profile.emailVerified === true;
```

## Recommended fix

Require the matched local account to be emailVerified before auto-linking (otherwise fail with AccountExists, as the unverified-provider path already does), or force a re-confirmation flow that invalidates any known credentials on link.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-account-linking-policy`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:762`. Fix: Auto-link only into a local account whose email is already verified. Otherwise answer AccountExists, as the explicit path does. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OAuth.callback auto-links only when trustedProviders includes the provider AND profile.emailVerified AND the existing local user's emailVerified; otherwise AccountExists. Tests (OAuth.test.ts 'account-linking trust policy'): trusted provider vs unverified local account -> AccountExists and nothing linked (red before: it linked), verified local account still links; the two existing auto-link tests now verify the local user first. BDD: new REQ-EA-339-tagged scenario 'A trusted provider never auto-links into a local account whose email is unverified' + step defs (existing Given now verifies the local user). BEH-EA-124 amended. Gates: tsc -b, tsconfig.test.json, vitest (password/ports hashing tests flaked once under machine load, green on rerun), test:bdd 105, spec:verify:strict, oxlint packages/oauth.
