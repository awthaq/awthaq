---
ID: "TS-002"
Title: "AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable"
Level: medium
Category: "architecture"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:78"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-002 — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable

`MEDIUM` · `architecture` · `qadi` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **resolved**

## Summary

The feature suite promises 'a user-table lookup failure maps to a typed AttributeResolveError' and 'a resolver failure is never indistinguishable from "this subject has no such attribute"' (features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.feature:22-40), and Path A requires resolver outages to surface as 5xx defects, never denials. The shipped resolver cannot satisfy this: the module header concedes 'a real SQL outage would surface as an unhandled defect... there is no genuine outage this resolver could report through AttributeResolveError even if it wanted to', and UserNotFound (a deleted mid-request user) collapses to undefined no-opinion exactly like an unrecognized attribute name. Decision determinism degrades unobservably: the evaluator cannot distinguish 'attribute absent' from 'attribute source down', which is the failure mode that turns policy audits into guesswork.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:78`

```
Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)),
);
return yield* subjectResolver.resolve(principal);
```

## Recommended fix

Add a typed store-unreachable error to the Users port (distinct from UserNotFound) and map it to AttributeResolveError in UserAttributes; keep deleted-user as no-opinion but consider a distinct reason so policy traces can tell the two apart.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/node_modules/@qadi/core/src/Evaluate.ts:346`. Fix: Make UserAttributes itself map store failures to AttributeResolveError (mirroring OrganizationQadi.attributes) and wire REQ-EA-452/453. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** UserAttributes maps a Users store outage (a defect from Users.findById) to AttributeResolveError naming the attribute; a deleted user stays 'no opinion' (undefined). Header comment rewritten (REQ-EA-452/453 semantics). Test: Resolvers.test.ts 'a Users outage fails AttributeResolveError naming the attribute' (red before: unhandled defect). Deferred: wiring the REQ-EA-452/453 BDD scenarios (feature is @skip @unwired at Feature level; not cheap). Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 915 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
