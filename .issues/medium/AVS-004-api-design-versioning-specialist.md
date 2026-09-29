---
ID: "AVS-004"
Title: "Password plugin squats root-level URL paths inside its namespaced group"
Level: medium
Category: "api"
Status: resolved
Package: "password"
Source: "packages/password/src/PasswordApi.ts:179"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-004 — Password plugin squats root-level URL paths inside its namespaced group

`MEDIUM` · `api` · `password` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

BEH-EA-004 confines a plugin's contract *groups* to its own id or dotted sub-id, but nothing constrains *paths*: the `password` group declares three root-level routes (`/verify-email`, `/resend-verification`, `/change-password`) alongside nine `/password/...` routes. The account-lifecycle rationale is documented in-file, but the reserved top-level space is otherwise unmanaged: core claims `/user`, password claims three more, and the next plugin that touches email verification (magic-link is a planned placeholder) collides with an unregistered, plugin-owned global path. The exception list lives in per-file comments, not in any registry a plugin author can consult.

## Evidence

Source: `packages/password/src/PasswordApi.ts:179`

```
// Shipping-gap map (.scratch/shipping-gaps), ticket 08: a top-level
// route, not nested under `/password/*` — account-lifecycle actions
```

## Recommended fix

Keep the routes if the product reasoning holds, but make the exception a first-class artifact: a reserved-root-path registry in `@awthaq/api` (exported const or spec table), checked by `Auth.make`'s composition like duplicate group ids already are, so a second claimant fails loudly at composition time instead of at runtime routing.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-002` — Self-service flows are ad-hoc endpoints, not resumable flow state machines](medium/AR-002-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CDS-003` — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental](medium/CDS-003-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-007` — Plugin contract convention drift: per-endpoint middleware inside a shared group](low/EHA-007-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`ESS-006` — Identity-bearing DTO fields are unrefined Schema.String](medium/ESS-006-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`RBS-002` — verifyEmail is the only token-consuming endpoint with no rate limit](medium/RBS-002-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`TMS-010` — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event](low/TMS-010-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-api-contract-hygiene`. Evidence at HEAD ec065a7: `packages/password/src/PasswordApi.ts:204`. Fix: Make route ownership a composition-time check instead of a registry of exceptions. (effort S). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Auth.make composeApi refuses a duplicate (method, path) across all contributed endpoints with RouteConflict (E_ROUTE_CONFLICT naming both plugins). Test: packages/core/test/RouteConflict.test.ts. spec BEH-EA-032 note lists password's root-level routes as informative.
