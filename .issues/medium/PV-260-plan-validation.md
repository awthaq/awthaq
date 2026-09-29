---
ID: "PV-260"
Title: "runPluginContractTests registers no hook-kind check although BEH-EA-200 requires one (observe taps cannot abort; observers are fail-isolated; only veto points abort)"
Level: medium
Category: "testing"
Status: open
Package: "test"
Source: "packages/test/src/TestAuth.ts:1"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-260 — runPluginContractTests registers no hook-kind check although BEH-EA-200 requires one

`MEDIUM` · `testing` · `test` · found while wiring `features/features/08-tooling/25-testing-harness.feature` (P20a)

Status: **open**

## Summary

`spec/behaviors/25-testing-harness.md` BEH-EA-200 says `runPluginContractTests` MUST assert that a hook tap on an observe point cannot abort the operation it observes, that an observer's failure does not propagate to fail that operation, and that only a veto-point tap may abort or amend. `TestAuth.runPluginContractTests` registers exactly these checks today: id collision, table prefix, `dependsOn` presence, migration-declaration determinism, migrations applied twice on two fresh databases, the opt-in redaction check, and contract stability across options. There is no hook-kind check (`TestAuth.ts` header: "BEH-EA-200 ... is directly testable via `HookPoint.ts`" and left to a plugin author to test by hand).

## Evidence

`packages/test/src/TestAuth.ts` — the `framework.it(...)` registrations inside `runPluginContractTests` (no hook check). Scenarios REQ-EA-569..572 in `features/features/08-tooling/25-testing-harness.feature` stay `@skip` citing this issue; the underlying property (an observe tap cannot abort, observer isolation, veto abort) is covered by `packages/core/test/HookPoint.test.ts`.

## Recommended fix

Add an opt-in `hooks` option to `runPluginContractTests` (a plugin's taps are registered through `Hooks.*.tap` layers passed by the author) that exercises each supplied tap against a stub input and asserts the kind rules, then un-skip REQ-EA-569..572.

## Comments

_Triage notes and discussion append here._
