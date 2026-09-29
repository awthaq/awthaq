---
ID: "TS-003"
Title: "No decision-sink or denial-explainability seam wired anywhere"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:11"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-003 — No decision-sink or denial-explainability seam wired anywhere

`MEDIUM` · `architecture` · `qadi` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **ready-for-agent**

## Summary

A repo-wide search finds DecisionSink/DecisionHistory/audit only in comments: the bridge ships no decision-logging layer, no denial-reason capture, and BEH-EA-166-168 (predicate-sql pushdown, audit sink, devtools stream) are declared application-level wiring. Consequence: an operator deploying this stack sees 403/404s (Path A deliberately blurs denial into 404 for tenant isolation) with zero server-side record of which policy denied, what the inputs were, or why. For a design that externalizes evaluation to a second library, shipping no first-party decision trace makes production debugging and compliance review dependent on the application author reinventing the sink every time — the highest-friction gap in the externalization story.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:11`

```
// - BEH-EA-164 (`DecisionHistory` backed by audit events) needs a durable
//   audit-event table this repository does not have — no `AuditLog`
//   service exists anywhere in `@awthaq/core` yet.
```

## Recommended fix

Ship an optional DecisionSink Layer plus a denial logWarning in AuthorizedSubjectLive/SubjectExtractorLive (subject, permission, decision tag) behind a config flag; defer the durable table, not the seam.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/Resolvers.ts:11`. Fix: Ship an opt-in DecisionSink implementation that logs denials (and optionally records them in AuditLog), and refresh the stale header. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
