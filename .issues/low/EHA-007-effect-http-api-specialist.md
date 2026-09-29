---
ID: "EHA-007"
Title: "Plugin contract convention drift: per-endpoint middleware inside a shared group"
Level: low
Category: "api"
Status: ready-for-agent
Package: "password"
Source: "packages/password/src/PasswordApi.ts:216"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-007 — Plugin contract convention drift: per-endpoint middleware inside a shared group

`LOW` · `api` · `password` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **ready-for-agent**

## Summary

packages/jwt/src/JwtApi.ts:14-16 documents the established pattern for mixing public and authenticated endpoints: 'a second, dotted-sub-id group carrying its own .middleware(Api.Authentication) ... never a per-endpoint middleware inside one shared group'. PasswordApi.ts:215-216 violates exactly that by attaching Authentication to the single changePassword endpoint inside the shared password group (alongside public signUp/signIn/reset endpoints), so the two plugin contracts follow different composition idioms. Per-endpoint middleware works at runtime, but reviewers scanning a group cannot see its auth requirements uniformly, and the jwt comment's stated rationale (predictable group-level auth surface) is silently inconsistent across plugins.

## Evidence

Source: `packages/password/src/PasswordApi.ts:216`

```
    }).middleware(Api.Authentication),
```

## Recommended fix

Split changePassword into a password.credentials (or password.change) dotted sub-group with group-level .middleware(Api.Authentication), matching PasskeyApi's passkey/passkey.authenticate split, and update the jwt comment's cross-reference.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-002` — Self-service flows are ad-hoc endpoints, not resumable flow state machines](medium/AR-002-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`AVS-004` — Password plugin squats root-level URL paths inside its namespaced group](medium/AVS-004-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`CDS-003` — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental](medium/CDS-003-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`ESS-006` — Identity-bearing DTO fields are unrefined Schema.String](medium/ESS-006-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`RBS-002` — verifyEmail is the only token-consuming endpoint with no rate limit](medium/RBS-002-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`TMS-010` — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event](low/TMS-010-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-api-contract-hygiene`. Evidence at HEAD ec065a7: `packages/password/src/PasswordApi.ts:249`. Fix: Split authenticated password endpoints into a `password.account` sub-group. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.
