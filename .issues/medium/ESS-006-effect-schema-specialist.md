---
ID: "ESS-006"
Title: "Identity-bearing DTO fields are unrefined Schema.String"
Level: medium
Category: "api"
Status: resolved
Package: "password"
Source: "packages/password/src/PasswordApi.ts:71"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-006 — Identity-bearing DTO fields are unrefined Schema.String

`MEDIUM` · `api` · `password` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

Every email field in every contract (SignUpPayload, SignInPayload, RequestResetPayload, AccountDto, invitations) is plain Schema.String: no format filter, no length bound, no normalization annotation. A signUp with email "junk" is accepted, stored, gets name = "junk" (Password.ts:480), and is addressable by password-reset mail flows. Password policy (min length, breach) is likewise checked ad hoc post-decode in checkPolicy rather than encoded via Schema.transformOrFail/filter — the repo demonstrates it knows the tool (the single Schema.makeFilter in AdminApi.ts:47) but applies it nowhere else. This is the persona rubric's 'strong signal' inverted: validation logic lives outside the schema boundary.

## Evidence

Source: `packages/password/src/PasswordApi.ts:71`

```
export const SignUpPayload = Schema.Struct({
  email: Schema.String,
  password: Schema.Redacted(Schema.String),
});
```

## Recommended fix

Introduce a shared Email schema (Schema.String with a makeFilter format check, documented as intentionally non-normalizing since the domain layer lower-cases) and use it in all contract payloads; encode the cheap half of password policy (min length) as a schema filter with hints assembled in the handler.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-002` — Self-service flows are ad-hoc endpoints, not resumable flow state machines](medium/AR-002-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`AVS-004` — Password plugin squats root-level URL paths inside its namespaced group](medium/AVS-004-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`CDS-003` — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental](medium/CDS-003-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-007` — Plugin contract convention drift: per-endpoint middleware inside a shared group](low/EHA-007-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`RBS-002` — verifyEmail is the only token-consuming endpoint with no rate limit](medium/RBS-002-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`TMS-010` — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event](low/TMS-010-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-api-contract-hygiene`. Evidence at HEAD ec065a7: `packages/password/src/PasswordApi.ts:71`. Fix: A shared `Email` schema at the contract boundary (+ a password length ceiling); runtime-config policy stays in checkPolicy. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/api/src/Email.ts (EmailContract.Email: one @, no whitespace, local<=64, dotted domain, <=254, non-normalizing) used for all password email payloads; password fields capped at 1024 (MAX_PASSWORD_LENGTH). Tests: packages/api/test/Email.test.ts, AuthHttp.test.ts (junk email and oversized password answer 400).
