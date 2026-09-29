---
ID: "PV-230"
Title: "RequirePermission serializes a resolver outage into its 502 body (attribute name and cause message), contradicting BEH-EA-157's empty body"
Level: medium
Category: "security"
Status: resolved
Package: "qadi"
Source: "../qadi packages/http/src/QadiHttpError.ts:187"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-230 — RequirePermission serializes a resolver outage into its 502 body

`MEDIUM` · `security` · `qadi` · found while wiring `features/features/06-roles-and-authorization-bridge/20-qadi-bridge-path-b.feature` (P20a, AH-003)

Status: **resolved**

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

**Plan note (2026-09-29, P20a):** Not fixable from this repository: the response encoding lives in @qadi/http (../qadi packages/http/src/QadiHttpError.ts, AttributeResolveErrorResponse and siblings, installed here as 0.7.0). The fix is to declare those five resolver-outage errors with an empty body schema (or convert them to an empty 502 the way AccessDenied is converted) in qadi and release it; the skipped Examples row of REQ-EA-440 then un-skips. Left open.

**Plan note (2026-09-29, P22):** Verified against ../qadi (main 0.8.0 and branch plan/audit-fixes): the leak the issue describes is already fixed upstream in be76b5b (0.8.0): the five outage *Response schemas are now independent Schema.TaggedStruct views carrying only one identifying field (attribute, relation+resourceId, event, name, subjectId+resourceId) and never the cause/reason, so the resolver's own error message no longer reaches a 502 body. awthaq still resolves @qadi/*@0.7.0 (catalog ^0.7.0), which is what leaks; bumping to ^0.8.0 needs the registry (not available offline here). What remains after the bump is a wording disagreement, not a leak: qadi deliberately keeps a typed tag-plus-one-identifier body (so a generated HttpApiClient can decode the outage as the typed error), while BEH-EA-157/REQ-EA-440 say empty body. Recommended: amend BEH-EA-157/REQ-EA-440 to 'no cause or internal message; at most the tag and the one identifying attribute' and un-skip the resolver-outage row after the bump; changing qadi to tag-only is the alternative and would cost the client-side typed decoding, so no qadi change was made. Left open.

**Resolved (2026-09-29):** Bumped @qadi/core, @qadi/http, @qadi/react to 0.8.0 (pnpm-workspace.yaml minimumReleaseAgeExclude, the nine package.json ranges, lockfile); typecheck and the qadi/roles/organization/admin/react/webhooks/cli tests are green unchanged (0.8.0 predates the unpublished plan/audit-fixes custom-predicate context, so awthaq needs no adaptation). 0.8.0 answers typed bodies: AccessDeniedPublic without the trace, tag-only UndischargedObligation, an outage as tag plus one identifying attribute and never the cause. BEH-EA-157 and REQ-EA-440 amended to say so (only the wiring-mistake 500 stays empty); the skipped resolver-outage row is un-skipped and the Examples now assert each outcome's body shape (20-qadi-bridge-path-b.feature, QadiBridgePathBSteps.ts). Changeset qadi-0-8-0.md.
