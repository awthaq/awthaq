---
ID: "CDS-003"
Title: "Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/PasswordApi.ts:152"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-003 — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental

`MEDIUM` · `security` · `password` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

sign-in, sign-up, and confirm-reset are public mutating endpoints with no CsrfProtection and no Origin/Sec-Fetch-Site validation anywhere in their request path. What currently blocks a cross-site login-CSRF forgery (attacker form-posts the victim's browser through sign-in with the attacker's credentials, the response sets __Host-session, and the victim continues browsing as the attacker) is an incidental stack: (1) the framework's payload decoder rejects any non-JSON content-type with 415 (HttpApiBuilder.ts:750-755), which HTML forms cannot produce; (2) no package sets CORS, so a cross-site fetch with content-type application/json dies at preflight; (3) SameSite=Strict. None of these is a designed login-CSRF defense — each is one payload-variant, one CORS layer added for a partner origin, or one legacy client away from silently disappearing.

## Evidence

Source: `packages/password/src/PasswordApi.ts:152`

```
HttpApiEndpoint.post("signIn", "/password/sign-in", {
```

## Recommended fix

Give credential-accepting endpoints an explicit defense: either attach CsrfProtection (the double-submit leg works pre-authentication since the cookie is minted on any request), or run an Origin/Sec-Fetch-Site check in a shared middleware; document that JSON-only body decoding and absent CORS are load-bearing for login-CSRF today.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-002` — Self-service flows are ad-hoc endpoints, not resumable flow state machines](medium/AR-002-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`AVS-004` — Password plugin squats root-level URL paths inside its namespaced group](medium/AVS-004-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`EHA-007` — Plugin contract convention drift: per-endpoint middleware inside a shared group](low/EHA-007-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`ESS-006` — Identity-bearing DTO fields are unrefined Schema.String](medium/ESS-006-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`RBS-002` — verifyEmail is the only token-consuming endpoint with no rate limit](medium/RBS-002-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`TMS-010` — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event](low/TMS-010-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-api-contract-hygiene`. Already fixed by commit 409334e. Evidence at HEAD ec065a7: `packages/password/src/PasswordApi.ts:254`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
