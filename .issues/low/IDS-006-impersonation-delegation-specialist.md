---
ID: "IDS-006"
Title: "Lifecycle events under-attribute: denied event omits the target, stopped event omits the admin"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:66"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-006 — Lifecycle events under-attribute: denied event omits the target, stopped event omits the admin

`LOW` · `security` · `core` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **resolved**

## Summary

`auth.admin.impersonationDenied` carries only adminUserId (AuthEvents.ts:77-80) even though targetUserId is known at the publish site (Admin.ts:216-219), so security monitoring cannot see who an unauthorized impersonation attempt aimed at - the most valuable field for detecting reconnaissance against privileged accounts. Symmetrically, `auth.admin.impersonationStopped` carries only sessionId and endedBy: consumers of the event stream (sinks, SIEM) cannot attribute an ended episode to its admin or target without joining the records store. The durable table has the fields; the events do not.

## Evidence

Source: `packages/core/src/AuthEvents.ts:66`

```
readonly sessionId: string;
  readonly endedBy: "self" | "forcedByAdmin" | "expired";
```

## Recommended fix

Add targetUserId to the denied event and adminUserId/targetUserId to the stopped event (sessionId join remains available); keep the table as the source of truth.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-event-schema`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:130`. Fix: Add attribution fields to the impersonation lifecycle events. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** auth.admin.impersonationDenied gains operation ('impersonate'|'forceStop'|'list') and optional targetUserId/sessionId; auth.admin.impersonationStopped gains adminUserId and targetUserId (from the closed episode record). Admin.ts deny(caller, attempt) names the refused call; sweepExpired/stopImpersonating/forceStop publish both parties. Tests: packages/admin/test/Admin.test.ts (denied names attempted target; stopped carries admin and target).
