---
ID: "PV-251"
Title: "BEH-EA-032's second half (raw `HttpApi.addHttpApi` rejects a duplicate group id) is not true: Effect replaces silently"
Level: medium
Category: "docs"
Status: resolved
Package: "core"
Source: "spec/behaviors/04-contract-stratum.md:BEH-EA-032"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-251 — BEH-EA-032's second half is not true: `HttpApi.addHttpApi` replaces a same-id group silently

`MEDIUM` · `docs` · `core` · found while wiring `04-contract-stratum.feature` (P20a, REQ-EA-082)

Status: **resolved**

## Summary

BEH-EA-032 / REQ-EA-082 say merging two raw contracts that declare the same group id outside `Auth.make`, via `HttpApi.addHttpApi`, "is rejected as `E_GROUP_CONFLICT`" and "neither group silently replaces the other". Effect's `addHttpApi` does the opposite: it copies every group with `InternalRecord.assignProperty`, last one wins, no error. awthaq refuses a duplicate only inside `Auth.make`'s `composeApi` (`GroupIdConflict`, REQ-EA-081/083/640 — all wired and green). A host that merges contracts by hand gets the silent replacement `composeApi`'s own comment warns about.

## Recommended fix

Reword BEH-EA-032 to say the refusal is `Auth.make`'s, and document that hand-merged contracts (`addHttpApi`) must go through `Auth.make`'s `extraGroups` (MW-002) instead; or ship a `mergeContracts` helper that refuses a duplicate. Then adjust or drop REQ-EA-082 (currently `@skip`ped with this id).

## Evidence

`node_modules/effect/src/unstable/httpapi/HttpApi.ts` `addHttpApi` (`assignProperty`); `packages/core/src/Auth.ts` `composeApi` comment on BEH-EA-032.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P20a):** Left open: the silent replacement happens inside effect's HttpApi.addHttpApi; awthaq only controls Auth.make, which already refuses a duplicate group id. The honest fix is to amend BEH-EA-082 to scope the refusal to Auth.make (spec prose, P19). REQ-EA-082 stays skipped.

**Resolved (2026-09-29):** Took the issue's first option (spec correction, no new helper): spec/behaviors/04-contract-stratum.md BEH-EA-032's requirement now says the refusal is Auth.make's (Validate for plugin classes; composeApi at composition for every merged group: plugins, core, extraGroups) and an as-shipped paragraph states that Effect's HttpApi.addHttpApi replaces a same-id group silently and hand-merging with it is unsupported; a host group goes through extraGroups. REQ-EA-082 was rewritten to that reality and un-skipped: 'A group a host adds through Auth.make's extraGroups is refused when its id is already composed' (GroupIdConflict naming core and host), new steps in ContractStratumSteps.ts; features/traceability.md row retitled. Gates: features 01-contract-and-persistence, spec:verify:strict, typecheck.
