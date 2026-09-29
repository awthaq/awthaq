---
ID: "PV-221"
Title: "BEH-EA-045's deployment-policy exception (allow a User with zero Accounts) has no implementation"
Level: low
Category: "correctness"
Status: open
Package: "core"
Source: "packages/core/src/Accounts.ts:598"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-221 — BEH-EA-045's deployment-policy exception (allow a User with zero Accounts) has no implementation

`LOW` · `correctness` · `core` · found while wiring `06-users-accounts.feature` (P20a, AH-003 tier 1); not in the original audit

Status: **open**

## Summary

BEH-EA-045 says unlinking a user's last Account MUST be refused "unless the deployment's policy explicitly allows it", and `06-users-accounts.feature` REQ-EA-125 specifies that scenario. `Accounts.unlink` (both `layerMemory` and `layerSql`) refuses the last Account unconditionally (`LastAccountRefusal`); no config, option or layer expresses such a policy, so the scenario cannot be wired and stays `@skip`.

## Evidence

- `packages/core/src/Accounts.ts:598`: `if (siblings.length <= 1) { return yield* Effect.fail(new LastAccountRefusal(...)) }` — no policy input.
- `features/features/02-domain/06-users-accounts.feature` REQ-EA-125 (`@skip`, cites this issue).

## Recommended fix

Either add an explicit `Accounts.config({ allowZeroAccounts: true })`-style policy (default false) that `unlink` consults, or amend BEH-EA-045 and REQ-EA-125 to drop the exception. Un-skip the scenario in the first case.

## Comments

_Triage notes and discussion append here._
