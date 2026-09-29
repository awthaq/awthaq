---
ID: "ESA-003"
Title: "Delivery is at-most-once with no replay: late or restarted consumers silently lose all prior events"
Level: medium
Category: "architecture"
Status: resolved
Package: "—"
Source: "archive/design/api-design.md:729"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-003 — Delivery is at-most-once with no replay: late or restarted consumers silently lose all prior events

`MEDIUM` · `architecture` · `—` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **resolved**

## Summary

stream is Stream.fromPubSub (packages/core/src/AuthEvents.ts:266): a subscriber sees only events published after it subscribes, a crashing subscriber loses whatever was in flight, and a restart loses everything. The design doc is honest that this is at-most-once and that the (absent, see ESA-001) audit table is supposed to compensate. Until that table exists, the runtime's only event history is a lossy buffer — the classic audit-vs-bus conflation the persona rubric flags, currently landing on the bus side with no compensating log. There is also no snapshot/replay story of any kind, so even a future consumer cannot backfill projections.

## Evidence

Source: `archive/design/api-design.md:729`

```
Delivery is at-most-once in-process over a bounded `PubSub`; the append-only `auth_audit` table is the record of record. Durable outbox is a later plugin over `SqlPersistedQueue`.
```

## Recommended fix

Keep the bus at-most-once (it is correctly scoped to observation), but make the durable append the recovery path: every event written to the table is replayable by sequence for projection backfill. If a cross-process consumer ever matters, layer the already-named durable-outbox plugin over SqlPersistedQueue rather than pretending PubSub semantics suffice.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: event durability & audit
- Full dossier: [`event-sourcing-audit-trail-specialist`](../../.reports/event-sourcing-audit-trail-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `events-delivery-durability`. Already fixed by commit 6bd3f1d. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:365`. Fix: Keep the bus at-most-once; make the durable AuditLog the recovery path: add a monotonic sequence and an ascending, cursor-based `replay` read (Stream) so consumers can backfill from a checkpoint. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** AuditLog.replay({ after, eventTag, batchSize }) is an ascending cursor-based Stream over the durable log (memory and SQL via AuditLogRepository.page), paging internally. Deviation from the dossier: no new 'sequence' column/migration. The cursor is the eventId, a time-ordered id that is monotonic within a process (cross-process order is ms-granular), which is dialect-neutral and testable here; a DB identity column would need pg-only SQL that cannot be verified in this environment and has the same commit-order caveat for tailing. Consumers checkpoint the last eventId, replay, then tail and dedupe on eventId; the relay in CWM-004 adds a settle delay for cross-process ordering. Documented in spec BEH-EA-102. Tests: AuditLog.test.ts replay across pages/after a checkpoint/by tag on both layers.
