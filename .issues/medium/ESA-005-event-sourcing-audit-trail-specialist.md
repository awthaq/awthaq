---
ID: "ESA-005"
Title: "Event payloads embed PII (email, login identifier, free-text reason) with no redaction or retention design for a durable sink"
Level: medium
Category: "compliance"
Status: ready-for-human
Package: "core"
Source: "packages/core/src/AuthEvents.ts:129"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-005 — Event payloads embed PII (email, login identifier, free-text reason) with no redaction or retention design for a durable sink

`MEDIUM` · `compliance` · `core` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **ready-for-human**

## Summary

OrganizationInvitationCreatedEvent carries the raw invitee email (AuthEvents.ts:129), TokenReplayEvent carries the probed login identifier — typically the email (AuthEvents.ts:25) — and AdminImpersonationStartedEvent carries unbounded free-text reason (AuthEvents.ts:59). The repo's own research layer sets the convention 'never credentials/tokens' for attributes and forbids unredacted sensitive attributes (research/01-effect-ecosystem.md:196-198), but events were exempted from that thinking. The moment ESA-001's table lands, these fields get baked into append-only, compliance-retained rows: an attacker probing reset links would write victim emails into an immutable log with no erasure path, and GDPR/CCPA deletion of a user would leave their address in the audit trail forever.

## Evidence

Source: `packages/core/src/AuthEvents.ts:129`

```
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
```

## Recommended fix

Decide the PII posture before the table exists: either store opaque references (userId/invitationId) in events and resolve emails only in read models, or hash identifiers the way Verification.ts already hashes token values (SHA-256, Verification.ts:147-148). Add a documented retention/redaction rule for the audit table in the same change.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-event-pii-posture`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:192`. Fix: Adopt a PII posture for events + audit rows (see decision D1), then implement: identifiers-only payloads, redacted observer-error logs, audit-row pseudonymization on erasure, and documented stream privilege. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-human.
