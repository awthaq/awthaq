---
ID: "GC-007"
Title: "AuthEvent union mixes branded and unbranded id fields"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:60"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-007 — AuthEvent union mixes branded and unbranded id fields

`LOW` · `dx` · `core` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **ready-for-agent**

## Summary

Inside one closed 25-member tagged union, `userId` fields are the branded `UserId` (AuthEvents.ts:31, 37, 50) while `AdminImpersonationStartedEvent.sessionId` is plain `string` — although `SessionId` is exported from Sessions.ts and the event's value is a real session id. Consumers pattern-matching the union get brand safety for one id concept and none for the other, and the plain string can flow back into `Sessions.revoke` with no compile-time guard. A small but telling inconsistency in an otherwise disciplined algebra.

## Evidence

Source: `packages/core/src/AuthEvents.ts:60`

```
  readonly sessionId: string;
```

## Recommended fix

Type the field as `SessionId` (a type-only import avoids any runtime cycle) and mint it from the SessionId the admin flow already holds.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-event-schema`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:68`. Fix: Brand session ids in the event union (type-only import to avoid a runtime cycle), as part of the ESA-007 schema migration. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
