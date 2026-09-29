---
ID: "ESA-002"
Title: "No event carries a timestamp or sequence number — post-hoc ordering and point-in-time reconstruction are impossible"
Level: high
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:55"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-002 — No event carries a timestamp or sequence number — post-hoc ordering and point-in-time reconstruction are impossible

`HIGH` · `correctness` · `core` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **resolved**

## Summary

All 25 event interfaces carry only a tag plus identifiers (or, at richest, a free-text reason). There is no occurredAt, no eventId, no per-aggregate or global sequence anywhere in AuthEvents.ts:23-210. FIFO order exists only inside the PubSub for a subscriber that is connected at publish time; once anything durable records these events, or once two sources interleave, nothing can order or correlate them. The compliance probe 'reconstruct exactly what this user's session state was at 3pm last Tuesday' is structurally unanswerable even if a table existed tomorrow, because the wire format has no time or ordering field to persist.

## Evidence

Source: `packages/core/src/AuthEvents.ts:55`

```
export interface AdminImpersonationStartedEvent {
  readonly _tag: "auth.admin.impersonationStarted";
  readonly adminUserId: UserId;
```

## Recommended fix

Add occurredAt (DateTime.Utc, stamped by the publisher) and a monotonic identity to the event envelope now, before a durable sink hard-codes its absence. The repo already prefers time-ordered identifiers (Model.UuidV7Insert in packages/sql/src/Models.ts:41) — a uuidv7 eventId plus occurredAt per event gives global orderability for free.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: event durability & audit
- Full dossier: [`event-sourcing-audit-trail-specialist`](../../.reports/event-sourcing-audit-trail-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-006` — Event payloads carry no timestamp, correlation id, or source context](medium/ALF-006-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-007` — on() subscriptions attach asynchronously — events published during startup are silently lost](medium/ALF-007-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-009` — PII rides the bus with no subscription access control or redaction](low/ALF-009-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CWM-004` — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto](medium/CWM-004-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/AuthEvents.ts:55-57` (`AdminImpersonationStartedEvent`) and every other of the 25 interfaces in the file (lines 23-208) carry only a `_tag` plus domain identifiers; none has an `occurredAt`/`eventId`/sequence field, confirmed by reading the full `AuthEvent` union (lines 213-238). The fix (stamp `occurredAt`/a uuidv7 `eventId` in the shared publish path at `AuthEvents.ts:263-264`) is a bounded, mechanical envelope addition. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-event-envelope`. Already fixed by commit 6bd3f1d. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:122`. Fix: Stamp one envelope (eventId uuidv7 + occurredAt) in `publish`, use it for both the AuditLog row and the bus, and deliver it to subscribers. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`.

**Resolved (2026-09-29):** publish stamps one envelope (eventId uuidv7-shaped and monotonic within a process via an in-layer Ref counter over Clock/Random, so AuthEvents gains no Crypto requirement; occurredAt; correlationId/ip/userAgent from AuthRequestContext; traceId/spanId of the current span) shared by the AuditLog row (row id = eventId) and the bus event; stream/on deliver Published. AuditLog.list breaks occurredAt ties by id desc (memory and SQL). Tests: AuthEvents.test.ts (delivered eventId/occurredAt equal the row; ids sort in publish order across 25 same-ms publishes), AuditLog.test.ts (same-ms newest-first).
