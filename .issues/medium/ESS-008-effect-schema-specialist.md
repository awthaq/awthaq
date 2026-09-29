---
ID: "ESS-008"
Title: "Three _tag strings duplicated across the Data and Schema error taxonomies"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Users.ts:38"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-008 — Three _tag strings duplicated across the Data and Schema error taxonomies

`MEDIUM` · `correctness` · `core` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **ready-for-agent**

## Summary

The deliberate split (domain-internal Data.TaggedError vs wire Schema.TaggedError) is good design, but three tags exist on both sides with identical strings: EmailAlreadyExists (core/Users.ts:38 vs password/PasswordApi.ts:35), TokenConsumed (core/Verification.ts:64 vs password/PasswordApi.ts:49), and SessionNotFound (core/Sessions.ts:113 vs api/Session.ts:33). Any code that ever puts both in one union — e.g. composing a core service call and a contract error in one handler's error channel — makes catchTag/catch ambiguous, and Effect's catchTag matches on exactly this string.

## Evidence

Source: `packages/core/src/Users.ts:38`

```
export class EmailAlreadyExists extends Data.TaggedError("EmailAlreadyExists")<{
```

## Recommended fix

Namespace the domain-side tags (e.g. "UserEmailAlreadyExists", "VerificationTokenConsumed", "CoreSessionNotFound") or document an enforced convention that a wire error must never reuse a Data.TaggedError tag; the Password.ts:482 catchTag mapping sites are the places to re-check after renaming.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `core-error-taxonomy`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:70`. Fix: Make internal (Data) and wire (Schema) error tags disjoint by construction and guard it with a test. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
