---
ID: "PV-261"
Title: "BEH-EA-196 and 25-testing-harness.feature name qadiTestLayer/subjectWith from @qadi/testing, which the suite cannot use (not a features dependency; the helpers do not exist under those names)"
Level: low
Category: "testing"
Status: resolved
Package: "features"
Source: "spec/behaviors/25-testing-harness.md:71"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-261 — BEH-EA-196's `qadiTestLayer`/`subjectWith` and the RequirePermission scenarios cannot be wired

`LOW` · `testing` · `features` · found while wiring `features/features/08-tooling/25-testing-harness.feature` (P20a)

Status: **resolved**

## Summary

BEH-EA-196 (REQ-EA-553..555) and BEH-EA-197's RequirePermission scenarios (REQ-EA-557/558) are phrased in terms of `@qadi/testing`'s `qadiTestLayer` and `subjectWith` and `@qadi/http`'s `RequirePermission`. `TestAuth.ts`'s own header records that `subjectWith` does not exist under that name in the installed `@qadi/core`/`@qadi/testing` (the real equivalents are `makeSubject`/`fromRoles`), and neither `@qadi/testing` nor `@qadi/http` is a dependency of `@awthaq/features`. Those five scenarios are `@skip` citing this issue.

## Recommended fix

Amend BEH-EA-196 to the real helper names, then add `@qadi/testing` and `@qadi/http` (version-matched to `@qadi/core`) as `features` devDependencies and wire REQ-EA-553..558 against `TestAuth.signInAs` + the real `AuthorizedSubject`/`RequirePermission` pipeline.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P22):** Spec half done, issue left open. BEH-EA-196's requirement now names the real helpers (makeSubject/fromRoles and currentSubjectLayer from @qadi/core, EvaluationServicesNone) with an as-shipped paragraph saying subjectWith/qadiTestLayer/@qadi/testing do not exist (the heading keeps its text so anchors stay valid); the skipped scenarios' comments say why (authoring guidance with no runtime behavior; @qadi/http is a features dependency by now, so that half of the issue text is stale). Remaining: REQ-EA-557/558 need a harness World that composes @qadi/http's RequirePermission and a policy with TestAuth.signInAs (a real fixture, not a text change); the property is covered today by 20-qadi-bridge-path-b.feature and packages/qadi/test/AuthorizedSubject.test.ts.

**Resolved (2026-09-29):** REQ-EA-557/558 wired: TestingHarnessWorld composes RequirePermission (real RequirePermissionLive over SubjectExtractorLive, the Roles resolver, EvaluationServicesNone) with TestAuth.layer and TestAuth.signInAs (roles via onSignedUp): an admin gets 200, a member 403 with an empty body from the real evaluator. BEH-EA-197 carries the as-shipped names. REQ-EA-553..555 stay skipped as pure authoring guidance (no runtime behavior; covered by packages/qadi/test/AuthorizedSubject.test.ts).
