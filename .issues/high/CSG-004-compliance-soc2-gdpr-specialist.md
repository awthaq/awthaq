---
ID: "CSG-004"
Title: "Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber"
Level: high
Category: "compliance"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:258"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-004 — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber

`HIGH` · `compliance` · `core` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

## Summary

AuthEvents is a bounded in-process PubSub, and the only subscriber in the repository is test code (packages/core/test/AuthEvents.test.ts:69). Nothing persists events, so the system's entire security-relevant history - sign-ins, admin impersonation start/stop, token replays, passkey counter anomalies - evaporates on restart or crash. SOC 2 CC7.2 anomaly-response and CC4.1 monitoring cannot be evidenced from this, and GDPR Art. 33 breach notification would have no forensic record to draw on. The payloads are well-designed for persistence (they reference UserId, not email, so pseudonymization is straightforward), which makes the missing sink the gap rather than the design.

## Evidence

Source: `packages/core/src/AuthEvents.ts:258`

```
const CAPACITY = 1024;
```

## Recommended fix

Ship a durable subscriber Layer for AuthEvents (append-only table behind a port, or external sink), define its retention period, and add an erasure-time pseudonymization step that replaces a deleted subject's UserId with an unrecoverable salted digest so the audit trail survives Art. 17 requests.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-006` — Event payloads carry no timestamp, correlation id, or source context](medium/ALF-006-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-007` — on() subscriptions attach asynchronously — events published during startup are silently lost](medium/ALF-007-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-009` — PII rides the bus with no subscription access control or redaction](low/ALF-009-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CWM-004` — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto](medium/CWM-004-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Durable audit/event trail sink architecture](../../.scratch/resolve-ready-for-human-findings/issues/01-durable-audit-event-sink.md) — new `AuditLog` core service, backed by a new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` itself; retention period and erasure-time pseudonymization are deferred to ticket 30 (`data-retention-gdpr-erasure`), but the schema's `actorUserId`/`payload` split is designed to support that later without a redesign. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `CAPACITY = 1024` confirmed at `packages/core/src/AuthEvents.ts:258`, an in-process bounded `PubSub` with no durable sink. Grepping every `packages/*/src` file for calls to `AuthEvents`/`events.stream`/`.on(` finds only publishers (password, oauth, passkey, admin, organization, Verification.ts) and zero production subscribers; only `packages/core/test/AuthEvents.test.ts` and other `test/` files subscribe. Choosing a durable sink, retention period, and pseudonymization design is a product/architecture decision. Status → ready-for-human.

**Resolved (2026-09-20):** Duplicate of [`ALF-001`](ALF-001-audit-logging-forensics-specialist.md) (same underlying gap, same wayfinder decision ticket). A new `AuditLog` core service now exists (`packages/core/src/AuditLog.ts`), backed by the new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` before every event reaches the `PubSub`. Retention period and erasure-time pseudonymization remain deferred, exactly as this finding's own decision noted — the schema's `actorUserId`/`payload` column split is deliberately friendly to a future pseudonymization pass without a redesign. See `ALF-001`'s own resolution comment for full implementation and verification detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
