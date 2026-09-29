---
ID: "GC-004"
Title: "Memory and SQL implementations of Users diverge on race failure modes"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Users.ts:260"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-004 — Memory and SQL implementations of Users diverge on race failure modes

`MEDIUM` · `correctness` · `core` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **resolved**

## Summary

`UsersShape.updateProfile` declares `Effect<UserRecord, UserNotFound>`, and layerMemory honors it under any interleaving (Ref.modify is atomic, Users.ts:144-155). layerSql instead does findById-then-update; if the row is deleted between the two calls, the repository's `update` fails NoSuchElementError which effect's SqlModel itself already converts to a defect (`Effect.catchTag("NoSuchElementError", Effect.die)` in SqlModel.js:50), and the outer `Effect.orDie` cements it — a legitimate, interface-supported race (`Users.delete` is public and Sessions/Accounts coordinate on it) crashes the fiber instead of failing with the declared UserNotFound the memory layer returns. `delete_` (Users.ts:282-285) has the same orDie posture. Two implementations of one Shape should share one failure law; here the algebra of the interface is only defined by whichever layer you happen to compose.

## Evidence

Source: `packages/core/src/Users.ts:260`

```
      const row = yield* repo.update(update).pipe(Effect.orDie);
```

## Recommended fix

Map NoSuchElementError from repo.update/repo.delete to `UserNotFound` in layerSql exactly as findById/verifyEmail already do, so both layers satisfy the Shape's declared error channel under concurrency.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-002` — UserRecord has no metadata field: Auth0 user_metadata/app_metadata have no storage target](high/AOMS-002-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`AOMS-008` — No bulk user import/export surface anywhere in the monorepo](medium/AOMS-008-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, medium)_`
- [`BE-007` — User profile is a closed shape — no user-field extension point for apps or plugins](medium/BE-007-bereket-engida.md) `_(bereket-engida, medium)_`
- [`BAM-009` — User profile surface cannot receive better-auth user fields: no image, no email change](medium/BAM-009-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`EEM-006` — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping](medium/EEM-006-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-008` — Three _tag strings duplicated across the Data and Schema error taxonomies](medium/ESS-008-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`FAMS-002` — UserRecord requires an email; Firebase anonymous and phone users cannot be represented](high/FAMS-002-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`MW-007` — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores](medium/MW-007-matias-woloski.md) `_(matias-woloski, medium)_`
- … 3 more findings touch `packages/core/src/Users.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `core-error-taxonomy`. Evidence at HEAD ec065a7: `packages/core/src/Users.ts:320`. Fix: Give UsersRepository a targeted, Option-returning profile update and map a missing row to UserNotFound so layerSql honors the Shape's declared E like layerMemory. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** UsersRepository.updateProfile: one UPDATE ... RETURNING * (findOneOption; two statements so metadata is bound and sealed only when supplied, null clears, undefined leaves it), None means the row is gone. Users.layerSql.updateProfile calls it directly and maps None to UserNotFound (no read-modify-write of email, no defect). Tests (red first: NoSuchElementError defect): a repository whose updateProfile finds no row gives UserNotFound; a real-DB round trip of name/metadata semantics. delete_ left as is: DELETE of a missing row is a no-op in both layers, it never died, so there was no divergence to align.
