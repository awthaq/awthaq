---
ID: "ESS-002"
Title: "The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only"
Level: high
Category: "compliance"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:12"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-002 — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only

`HIGH` · `compliance` · `qadi` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **resolved**

## Summary

BEH-EA-100: 'The audit trail of security-relevant operations MUST be written durably (to persistence) as part of the operation itself, and MUST NOT depend on any AuthEvents subscriber being present, running, or having succeeded.' Nothing in the repo persists an auth event: the bus is a Layer-scoped PubSub, so every event — including security-relevant ones like auth.token.replay and auth.passkey.counterAnomaly — is lost on process restart, and a replay probe leaves no durable trace. The codebase itself acknowledges the gap: qadi's BEH-EA-164 DecisionHistory resolver is unimplemented for exactly this reason, and the spec example's AuditLog service (spec/behaviors/13-events.md:24) does not exist. The spec header frames these documents as intended design for a pre-implementation project, but the package is otherwise shipped and BEH-EA-100 is a MUST — the durable half of the events domain is missing, and the streaming half (the batched Stream consumer that would write the audit table) is precisely where it would live.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:12`

```
// - BEH-EA-164 (`DecisionHistory` backed by audit events) needs a durable
//   audit-event table this repository does not have — no `AuditLog`
//   service exists anywhere in `@awthaq/core` yet.
```

## Recommended fix

Implement an AuditLog repository in the sql package plus a Layer that subscribes to events.stream and writes durably, using Stream.groupedWithin(batchSize, maxDelay) + Stream.buffer so a slow database neither drops events unboundedly nor stalls the bus; simultaneously this becomes the reference backpressured consumer the example app currently lacks.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Stream & backpressure
- Full dossier: [`effect-stream-specialist`](../../.reports/effect-stream-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Durable audit/event trail sink architecture](../../.scratch/resolve-ready-for-human-findings/issues/01-durable-audit-event-sink.md) — new `AuditLog` core service, backed by a new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` itself; a `Stream`-based subscriber (this finding's own suggested batching consumer) was explicitly rejected as the primary durability mechanism since BEH-EA-100 forbids depending on any subscriber. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/qadi/src/Resolvers.ts:12-16` verbatim matches the quoted comment, and `spec/behaviors/13-events.md:58-65` (BEH-EA-100) confirms the durability requirement. This is the same underlying gap as ESA-001 (no `AuditLog`/durable table exists anywhere in the repo), which needs a genuine cross-package design decision (schema, write-path, batching strategy), not a single mechanical patch. Status → ready-for-human.

**Resolved (2026-09-20):** Duplicate of [`ALF-001`](ALF-001-audit-logging-forensics-specialist.md) (same underlying gap, same wayfinder decision ticket). A new `AuditLog` core service now exists (`packages/core/src/AuditLog.ts`), written inline by `AuthEvents.publish` before every event reaches the `PubSub`. Per the decision's own analysis, a `Stream`-based subscriber (this finding's own suggested batching consumer) was explicitly rejected as the *primary* durability mechanism — it remains the right tool for a secondary, non-authoritative consumer, but BEH-EA-100 forbids depending on any subscriber for the record of record itself. See `ALF-001`'s own resolution comment for full implementation and verification detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
