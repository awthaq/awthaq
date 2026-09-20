---
ID: "ESA-001"
Title: "BEH-EA-100's durable audit table does not exist anywhere — every security event is process-local and dies with the process"
Level: high
Category: "compliance"
Status: resolved
Package: "—"
Source: "spec/behaviors/13-events.md:65"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-001 — BEH-EA-100's durable audit table does not exist anywhere — every security event is process-local and dies with the process

`HIGH` · `compliance` · `—` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **resolved**

## Summary

The spec makes a durable, subscriber-independent audit table the record of record, but packages/sql ships exactly five tables (users, accounts, sessions, verification_tokens, verification_reservations — CoreMigrations.ts:59-190) and zero audit tables; grep for 'audit' across packages/sql returns nothing, and qadi's AuditTrailPort (referenced as AuthAuditTrail in spec/appendices/02-qadi-path-a-end-to-end.md:318) is implemented in no package. Sign-ins (packages/password/src/Password.ts:495), token replays (packages/core/src/Verification.ts:224), and impersonation denials exist only as transient in-memory messages. An incident reviewer cannot answer 'was this account accessed at all last month' from anything the runtime persists — the exact failure mode the spec wrote BEH-EA-100 to prevent ('disabling or misconfiguring event subscribers can never cause an audit gap') is the permanent default state.

## Evidence

Source: `spec/behaviors/13-events.md:65`

```
REQUIREMENT: The audit trail of security-relevant operations MUST be
             written durably (to persistence) as part of the operation
             itself, and MUST NOT depend on any `AuthEvents` subscriber
```

## Recommended fix

Land an append-only auth_events (or auth_audit) table via the plugin-owned pattern the repo already proved (admin plugin declares tables: ["admin_impersonation"] and builds layerSql on SqlSchema — packages/admin/src/ImpersonationRecords.ts:204). Write the row inside each security-relevant operation (same transaction where possible), never via a PubSub subscriber, and back a generic AuditSink port so plugins append without a new migration each.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: event durability & audit
- Full dossier: [`event-sourcing-audit-trail-specialist`](../../.reports/event-sourcing-audit-trail-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ESA-006` — Session lifecycle events are absent from the registry — revocation, the event that must never be silently dropped, is unobservable](medium/ESA-006-event-sourcing-audit-trail-specialist.md) `_(event-sourcing-audit-trail-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Durable audit/event trail sink architecture](../../.scratch/resolve-ready-for-human-findings/issues/01-durable-audit-event-sink.md) — new `AuditLog` core service, backed by a new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` itself (not a subscriber) for all 25 registry event tags. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/CoreMigrations.ts:59-190` defines exactly five tables (users, accounts, sessions, verification_tokens, verification_reservations) and a repo-wide grep for "audit" under `packages/sql` returns nothing; `packages/qadi/src/Resolvers.ts:12-16` itself acknowledges "no `AuditLog` service exists anywhere in `@awthaq/core` yet". `spec/behaviors/13-events.md:58-65` (BEH-EA-100) does mandate durable, subscriber-independent persistence. This is a genuine cross-package gap (schema design, write-path ownership, transactional semantics) rather than a one-file fix. Status → ready-for-human.

**Resolved (2026-09-20):** Duplicate of [`ALF-001`](ALF-001-audit-logging-forensics-specialist.md) (same underlying gap, same wayfinder decision ticket). A new `AuditLog` core service now exists (`packages/core/src/AuditLog.ts`), backed by the new `auth_audit_log` SQL table (`packages/sql/src/CoreMigrations.ts` migration 13), written inline by `AuthEvents.publish` before every event reaches the `PubSub` — durable, and independent of any subscriber, exactly as BEH-EA-100 requires. See `ALF-001`'s own resolution comment for full implementation and verification detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
