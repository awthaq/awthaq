---
ID: "AR-002"
Title: "Self-service flows are ad-hoc endpoints, not resumable flow state machines"
Level: medium
Category: "architecture"
Status: needs-triage
Package: "password"
Source: "packages/password/src/PasswordApi.ts:136"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-002 — Self-service flows are ad-hoc endpoints, not resumable flow state machines

`MEDIUM` · `architecture` · `password` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **needs-triage**

## Summary

Login, registration, recovery, and settings are direct one-shot POSTs (POST /password/sign-in, /password/request-reset, /change-password) with no flow object: no flow id, no server-held per-flow expiry, no multi-step state a client resumes. Kratos-style flow state machines matter for headless platforms because they let a UI render, re-render after validation errors, and complete multi-step journeys (choose method -> factor two -> finish) against one stable resource. Only the OAuth plugin implements real server-side flow state (purpose 'oauth.flow', 10-minute TTL, single-use consumption in packages/oauth/src/OAuth.ts:76); everything else front-of-house is stateless request/response. This is a defensible better-auth/Lucia-style choice, but it caps composability: exactly the gap AR-001 exposes for MFA.

## Evidence

Source: `packages/password/src/PasswordApi.ts:136`

```
export const PasswordGroup = HttpApiGroup.make("password")
```

## Recommended fix

Either document one-shot endpoints as the deliberate contract (and lean on the divert-hook outcome union for multi-step), or introduce a minimal flow resource for credential journeys: create-flow returns {id, expiresAt, csrfToken}, submit targets /flows/:id, state lives in the existing Verification machinery awthaq already trusts for oauth.flow.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-004` — Password plugin squats root-level URL paths inside its namespaced group](medium/AVS-004-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`CDS-003` — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental](medium/CDS-003-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-007` — Plugin contract convention drift: per-endpoint middleware inside a shared group](low/EHA-007-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`ESS-006` — Identity-bearing DTO fields are unrefined Schema.String](medium/ESS-006-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`RBS-002` — verifyEmail is the only token-consuming endpoint with no rate limit](medium/RBS-002-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`TMS-010` — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event](low/TMS-010-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `password-api-contract-hygiene`. Evidence at HEAD ec065a7: `packages/password/src/PasswordApi.ts:149`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/07-password-mfa.md`.
