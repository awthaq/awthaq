---
ID: "PV-250"
Title: "BEH-EA-026's combined `SessionView` wire shape is not shipped: sign-in, sign-up and GET /session return three different things"
Level: medium
Category: "docs"
Status: resolved
Package: "api"
Source: "packages/api/src/Subject.ts:1"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-250 — BEH-EA-026's combined `SessionView` wire shape is not shipped

`MEDIUM` · `docs` · `api` · found while wiring `04-contract-stratum.feature` (P20a, REQ-EA-062/064)

Status: **resolved**

## Summary

BEH-EA-026 requires `SessionView = { principal, user, session, subject }` as one struct returned identically by sign-in, sign-up and `GET /auth/session`. The shipped contract returns `SessionDto` from `GET /session` and the password endpoints, and the authorization subject is a separate `GET /subject` atom (`packages/api/src/Subject.ts`'s own header explains why the server cannot assemble one struct: qadi is a stratum above the server). This is a deliberate design divergence, recorded only in that source comment; the spec and the scenarios still describe the combined shape.

## Recommended fix

Decide one side: amend BEH-EA-026 (and REQ-EA-062/064) to the two-contract shape (`SessionDto` + `SubjectDto` composed client-side, as `@awthaq/react`'s `Providers` does), or add a composed endpoint in the qadi stratum that returns the combined struct. Un-skip or rewrite REQ-EA-062/064 accordingly.

## Evidence

`packages/api/src/Subject.ts` header; `packages/api/src/Session.ts` (`current` returns `SessionDto`); `spec/behaviors/04-contract-stratum.md` BEH-EA-026.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P20a):** Left open: the combined SessionView of BEH-EA-026 is a feature, not a defect fix; needs a decision on whether to ship it or amend BEH-EA-026 (P19/P12 territory). REQ-EA-062..064 stay skipped with this id.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted amending the spec to the two-contract shape (SessionDto + SubjectDto composed client-side), per the layering reason recorded in packages/api/src/Subject.ts (the subject comes from qadi, a stratum above the server; roles in the session DTO would contradict api/qadi layering); user may revisit. spec/behaviors/04-contract-stratum.md BEH-EA-026 has an as-shipped paragraph. REQ-EA-062 and REQ-EA-064 rewritten to the shipped shapes and un-skipped: 062 checks SessionDto and SubjectDto field sets, 064 signs a user up, signs in, requests the current session and decodes all three answers as the same SessionDto (steps in ContractStratumSteps.ts; features/traceability.md retitled). REQ-EA-063 keeps its own skip reason. Gates: features 01-contract-and-persistence, spec:verify:strict, typecheck.
