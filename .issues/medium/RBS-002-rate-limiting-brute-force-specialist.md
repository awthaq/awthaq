---
ID: "RBS-002"
Title: "verifyEmail is the only token-consuming endpoint with no rate limit"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/PasswordApi.ts:188"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-002 — verifyEmail is the only token-consuming endpoint with no rate limit

`MEDIUM` · `security` · `password` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

RATE_LIMITS (Password.ts:155-166) has no verifyEmail entry, no rateLimit call guards the handler (Password.ts:667-676 goes straight to verification.consume), no registry rule is registered for it, and the contract declares no Api.RateLimited — so POST /verify-email accepts unlimited online guessing attempts against the emailed token. The 256-bit token entropy (Verification.ts:152) makes guessing infeasible today, but this is the single divergence from the plugin's own every-credential-route-is-throttled posture, and any future entropy reduction or token-format change silently becomes an online brute-force hole.

## Evidence

Source: `packages/password/src/PasswordApi.ts:188`

```
HttpApiEndpoint.post("verifyEmail", "/verify-email", {
      payload: VerifyEmailPayload,
      error: TokenConsumed,
```

## Recommended fix

Add a confirmReset-style rule keyed on the decoded identifier (`verify-email:<userId>`), a matching RATE_LIMITS.verifyEmail entry and registry rule, and declare Api.RateLimited on the endpoint, mirroring confirmReset exactly.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: brute-force defense
- Full dossier: [`rate-limiting-brute-force-specialist`](../../.reports/rate-limiting-brute-force-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-002` — Self-service flows are ad-hoc endpoints, not resumable flow state machines](medium/AR-002-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`AVS-004` — Password plugin squats root-level URL paths inside its namespaced group](medium/AVS-004-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`CDS-003` — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental](medium/CDS-003-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-007` — Plugin contract convention drift: per-endpoint middleware inside a shared group](low/EHA-007-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`ESS-006` — Identity-bearing DTO fields are unrefined Schema.String](medium/ESS-006-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`TMS-010` — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event](low/TMS-010-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-rate-limit-hardening`. Already fixed by commit cbf899d. Evidence at HEAD ec065a7: `packages/password/src/PasswordApi.ts:204`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
