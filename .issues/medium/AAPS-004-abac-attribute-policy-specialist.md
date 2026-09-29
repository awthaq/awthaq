---
ID: "AAPS-004"
Title: "One store round trip per attribute reference, no per-evaluation memoization"
Level: medium
Category: "performance"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:65"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-004 — One store round trip per attribute reference, no per-evaluation memoization

`MEDIUM` · `performance` · `qadi` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

readAttribute (@qadi/core Evaluate.ts:404-410) falls through to the resolver on every policy node that references an attribute not embedded in the subject, and UserAttributes issues a full `users.findById` per call. A composite policy citing `email` and `emailVerified` pays two complete user lookups per evaluation; `Qadi.filter` over a stream re-pays them per item; the whole record is fetched to read one field. DecisionCache mitigates only identical (subject, policy, resource) repeats and is absent by default (DecisionCache.ts:8-10), and awthaq never applies qadi's own `attributeResolverBounded` concurrency wrapper. This is exactly the per-check database round trip the hiring rubric flags as an ABAC scale failure.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:65`

```
return users.findById(userId).pipe(
  Effect.map((user): unknown => {
```

## Recommended fix

Hydrate once: have the SubjectResolver (or a wrapping AttributeResolver) bulk-load the user record per request and merge it into `AuthSubject.attributes` at subject construction — readAttribute's embedded-first precedence (Evaluate.ts:408-410) already serves embedded values without resolver trips — or memoize resolve results per fiber/evaluation id.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/Resolvers.ts:73`. Fix: Memoize the user record per request (not across requests), so N attribute reads cost one lookup without introducing cross-request staleness. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** UserAttributes memoizes the user lookup per request, keyed on the ambient HttpServerRequest's identity (WeakMap, the same per-request key Authentication.ts's session cache uses — no middleware/wiring, works for Path A and B; no memo outside an HTTP request). Concurrent reads share one Effect.cached lookup. Tests: Resolvers.test.ts 'one Users.findById per request for many attribute reads; a new request re-reads' (counting Users layer; red: 3 lookups) and 'outside any HTTP request there is no memo'. Deviation from the dossier: no UserRecordMemo Context.Reference — the request-identity WeakMap needs no provider in either bridge. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 915 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
