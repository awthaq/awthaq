---
ID: "PV-230"
Title: "RequirePermission serializes a resolver outage into its 502 body (attribute name and cause message), contradicting BEH-EA-157's empty body"
Level: medium
Category: "security"
Status: open
Package: "qadi"
Source: "../qadi packages/http/src/QadiHttpError.ts:187"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-230 — RequirePermission serializes a resolver outage into its 502 body

`MEDIUM` · `security` · `qadi` · found while wiring `features/features/06-roles-and-authorization-bridge/20-qadi-bridge-path-b.feature` (P20a, AH-003)

Status: **open**

## Summary

`spec/behaviors/20-qadi-bridge-path-b.md` (BEH-EA-157) and REQ-EA-440 say every `RequirePermission` outcome
answers its designated status **with an empty body**. `AccessDenied`, `UndischargedObligation`, a missing
annotation and `SubjectExtractionFailed` do (hand-converted to `HttpServerResponse.empty`). A resolver outage
does not: `AttributeResolveError`, `RelationshipResolveError`, `DecisionHistoryUnavailable`,
`CustomPredicateError` and `SignatureHistoryUnavailable` are declared as middleware `error` schemas
(`AttributeResolveErrorResponse = AttributeResolveError.pipe(httpApiStatus 502)`) and propagate typed, so the
response encoder writes the whole error into the 502 body:

```
{"_tag":"AttributeResolveError","attribute":"plan","cause":{"name":"Error","message":"<internal message>"}}
```

That leaks which attribute a policy reads and the failing dependency's own error message to the caller, on the
one status that is by definition an internal outage.

## Evidence

Reproduced through the BDD fixture (`features/step-definitions/QadiBridgeWorld.ts`, `/b/plan` with a failing
`AttributeResolver`): status 502 (correct), body non-empty. The Examples row `a resolver outage` of
REQ-EA-440 is `@skip`'d against this issue; REQ-EA-442 (502, never 403) passes.

## Recommended fix

In `../qadi` (`@qadi/http`, out of this repo): give the five outage schemas a tag-only response shape the way
`AccessDeniedRefused` is (a `Schema.TaggedStruct` with `httpApiStatus(502)` and no `cause`/`attribute` fields),
or hand-convert them to `HttpServerResponse.empty({ status: 502 })` like the other refusals. Then un-skip the
row. awthaq's bridge cannot fix it locally: it adds no middleware of its own on Path B (REQ-EA-441).

## Comments

_Triage notes and discussion append here._
