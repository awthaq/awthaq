---
ID: "EEM-006"
Title: "PlatformError sits in core typed channels, taxing every plugin call site with a die mapping"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:59"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-006 — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping

`MEDIUM` · `architecture` · `core` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **resolved**

## Summary

Six core service signatures export PlatformError.PlatformError — a condition no caller can recover from, only die on — so every plugin must repeat Effect.catchTag('PlatformError', Effect.die) (Password.ts:483/632/675, OAuth.ts:535/693) or Effect.orDie at each call site. The codebase's own SQL layers already draw the line internally (Users.ts:206-212: non-UniqueViolation repository failures are 'a genuine defect, not a domain error'), yet the published signatures keep the platform error, and one forgotten mapping is a compile error waiting at the next call site. The inconsistent convention (SqlError collapsed inside layerSql, PlatformError exported to callers) is exactly the kind of taxonomy drift across independently authored packages this discipline exists to prevent.

## Evidence

Source: `packages/core/src/Users.ts:59`

```
}) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
```

## Recommended fix

Draw the platform boundary once inside each core Layer (orDie at the seam, as layerSql already does for SqlError) so public error channels carry only domain errors callers can meaningfully handle.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`GC-004` — Memory and SQL implementations of Users diverge on race failure modes](medium/GC-004-giulio-canti.md) `_(giulio-canti, medium)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `core-error-taxonomy`. Duplicate of `MA-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:88`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MA-004-michael-arnaldi` — closed by its fix (see that issue's Resolved comment).
