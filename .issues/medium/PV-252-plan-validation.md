---
ID: "PV-252"
Title: "INV-EA-016 / BEH-EA-040 (a plugin migration may not alter a shared table) has no enforcement at all"
Level: medium
Category: "testing"
Status: resolved
Package: "core"
Source: "spec/invariants.md:183"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-252 — INV-EA-016 / BEH-EA-040 (a plugin migration may not alter a shared table) has no enforcement at all

`MEDIUM` · `testing` · `core` · found while wiring `05-persistence-stratum.feature` (P20a, REQ-EA-106..108)

Status: **resolved**

## Summary

`spec/invariants.md` INV-EA-016 says "Planned: `packages/sql/test/MigrationOwnership.test.ts` (no test exists yet)", and BEH-EA-040 scenarios REQ-EA-106..108 promise that a plugin migration that `ALTER TABLE users`s is *rejected*, that extension happens through a declared extension point, and that a shared-table extension is a primitive/nullable scalar. Nothing implements any of it: `Auth.make` never inspects what a migration's `up` touches (its `up` is an opaque `Effect`), and there is no `SessionClaims` registry in the shipped code. A plugin can freely alter `users`/`sessions`.

## Recommended fix

Either enforce it where it can be observed — `runPluginContractTests`' migration check (`packages/test/src/TestAuth.ts`) already applies a plugin's migrations to a fresh SQLite database; extend it to apply core's migrations first, diff `sqlite_master` for the core tables before/after, and fail if any core table changed or any created table is outside `<id>_` — or downgrade BEH-EA-040's second half in the spec to "planned". The wired scenario REQ-EA-105 already performs exactly this check over the shipped plugins (`features/step-definitions/PersistenceMigrationSteps.ts`), so the logic exists once it is lifted into the harness. Un-skip REQ-EA-106..108 when it lands.

## Evidence

`spec/invariants.md` INV-EA-016; `spec/traceability.md` row for INV-EA-016 ("Planned"); no file `packages/sql/test/MigrationOwnership.test.ts`.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P20a):** Left open: INV-EA-016 enforcement (a migration cannot alter a shared table) needs a statement-level check in Migrations.run or a validating test harness; larger than a cheap fix and it wants a design call on how to inspect raw SQL. REQ-EA-106..108 stay skipped.

**Resolved (2026-09-29):** Enforcement for the migration-DDL half of INV-EA-016 landed where the issue recommended: packages/test/src/TestAuth.ts runPluginContractTests gains a check that applies core's migrations, snapshots what core created, then applies the composition's plugin migrations on a fresh SQLite database and fails (message names INV-EA-016 and the object) if any core table/index was altered or dropped (its sqlite_master SQL changed) or anything new hangs off a table outside every installed plugin's own prefix (an index on a core table included). Red first: packages/test/test/runPluginContractTests.test.ts migration-ownership tests (ALTER users, index on users, stray table, own-prefix table passes). Every shipped plugin's contract suite still passes (full suite 3049 tests). REQ-EA-106 un-skipped and wired (a plugin migration ALTERing users is rejected; PersistenceMigrationSteps.ts). spec/invariants.md INV-EA-016 and spec/traceability.md updated (the planned MigrationOwnership.test.ts is retired; verify-traceability.sh now treats zero Planned cells as PASS instead of SKIP). Left skipped with updated reasons: REQ-EA-107 (needs a SessionClaims registry that does not exist; the shipped extension point for users is AuthPlugin.userFields) and REQ-EA-108 (needs the user-field kinds asserted as the scalar limit). Gates: typecheck, full test, features 01-contract, spec:verify:strict.
