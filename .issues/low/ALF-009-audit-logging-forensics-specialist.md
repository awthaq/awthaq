---
ID: "ALF-009"
Title: "PII rides the bus with no subscription access control or redaction"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:129"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-009 — PII rides the bus with no subscription access control or redaction

`LOW` · `security` · `core` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

invitationCreated broadcasts the invitee's raw email address, and impersonationStarted carries the admin's free-text reason (up to 1000 characters per ReasonSchema) which may embed personal data; every subscriber sees both, and a failing handler's Cause is logged verbatim under auth.event.observer.error (:294), giving PII a second egress path. Any Layer in the composition can silently subscribe to the full stream — there is no ACL on subscriptions, no record of who is consuming, and no redaction interceptor (the BEH-EA-199 redactor exists only as a spec sketch). Stream access is de facto privilege-equivalent to reading an audit table, but nothing communicates that.

## Evidence

Source: `packages/core/src/AuthEvents.ts:129`

```
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
```

## Recommended fix

Carry identifiers, not raw contact fields, in payloads (subscribers join email via Users when they need it); route observer-error causes through a redacting summary; document on the AuthEventsShape contract that stream access must be treated as audit-table-level privilege.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-006` — Event payloads carry no timestamp, correlation id, or source context](medium/ALF-006-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-007` — on() subscriptions attach asynchronously — events published during startup are silently lost](medium/ALF-007-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`CWM-004` — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto](medium/CWM-004-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `auth-event-pii-posture`. Duplicate of `ESA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:192`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
