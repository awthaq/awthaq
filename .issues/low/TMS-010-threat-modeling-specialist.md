---
ID: "TMS-010"
Title: "verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event"
Level: low
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/PasswordApi.ts:188"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-010 — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event

`LOW` · `security` · `password` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

verifyEmail is the one token-consuming endpoint with no rate limit — neither a rateLimit() call in the service (Password.ts:667-692) nor an Api.RateLimited entry in its contract, unlike all six sibling endpoints. Each request bearing a syntactically valid <identifier>.<hex> token reaches Verification.consume, which publishes auth.token.replay on every miss (Verification.ts:224). An unauthenticated client can therefore generate audit events at line rate — drowning the replay signal operators are supposed to alert on (INV-EA-010's stated purpose) and, per TMS-002, filling the bounded PubSub until publishes suspend. Token space is unguessable so this is flooding, not brute force.

## Evidence

Source: `packages/password/src/PasswordApi.ts:188`

```
    HttpApiEndpoint.post("verifyEmail", "/verify-email", {
      payload: VerifyEmailPayload,
      error: TokenConsumed,
```

## Recommended fix

Add a RATE_LIMITS.verifyEmail rule (keyed on the decoded identifier) plus an IP dimension, and consider coalescing replay events per identifier so a flood cannot drown the stream.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-002` — Self-service flows are ad-hoc endpoints, not resumable flow state machines](medium/AR-002-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`AVS-004` — Password plugin squats root-level URL paths inside its namespaced group](medium/AVS-004-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`CDS-003` — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental](medium/CDS-003-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-007` — Plugin contract convention drift: per-endpoint middleware inside a shared group](low/EHA-007-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`ESS-006` — Identity-bearing DTO fields are unrefined Schema.String](medium/ESS-006-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`RBS-002` — verifyEmail is the only token-consuming endpoint with no rate limit](medium/RBS-002-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `password-rate-limit-hardening`. Already fixed by commit cbf899d. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:1043`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
