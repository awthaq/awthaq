---
ID: "PV-252"
Title: "INV-EA-016 / BEH-EA-040 (a plugin migration may not alter a shared table) has no enforcement at all"
Level: medium
Category: "testing"
Status: open
Package: "core"
Source: "spec/invariants.md:183"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-252 — INV-EA-016 / BEH-EA-040 (a plugin migration may not alter a shared table) has no enforcement at all

`MEDIUM` · `testing` · `core` · found while wiring `05-persistence-stratum.feature` (P20a, REQ-EA-106..108)

Status: **open**

## Summary

`spec/invariants.md` INV-EA-016 says "Planned: `packages/sql/test/MigrationOwnership.test.ts` (no test exists yet)", and BEH-EA-040 scenarios REQ-EA-106..108 promise that a plugin migration that `ALTER TABLE users`s is *rejected*, that extension happens through a declared extension point, and that a shared-table extension is a primitive/nullable scalar. Nothing implements any of it: `Auth.make` never inspects what a migration's `up` touches (its `up` is an opaque `Effect`), and there is no `SessionClaims` registry in the shipped code. A plugin can freely alter `users`/`sessions`.

## Recommended fix

Either enforce it where it can be observed — `runPluginContractTests`' migration check (`packages/test/src/TestAuth.ts`) already applies a plugin's migrations to a fresh SQLite database; extend it to apply core's migrations first, diff `sqlite_master` for the core tables before/after, and fail if any core table changed or any created table is outside `<id>_` — or downgrade BEH-EA-040's second half in the spec to "planned". The wired scenario REQ-EA-105 already performs exactly this check over the shipped plugins (`features/step-definitions/PersistenceMigrationSteps.ts`), so the logic exists once it is lifted into the harness. Un-skip REQ-EA-106..108 when it lands.

## Evidence

`spec/invariants.md` INV-EA-016; `spec/traceability.md` row for INV-EA-016 ("Planned"); no file `packages/sql/test/MigrationOwnership.test.ts`.

## Comments

_Triage notes and discussion append here._
