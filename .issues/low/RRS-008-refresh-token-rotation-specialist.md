---
ID: "RRS-008"
Title: "No session-lifecycle events: rotation, supersession, and reuse are unobservable"
Level: low
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:24"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-008 — No session-lifecycle events: rotation, supersession, and reuse are unobservable

`LOW` · `architecture` · `core` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **ready-for-agent**

## Summary

The event registry's only token-adjacent tag is verification's auth.token.replay; there is no auth.session.rotated, auth.session.superseded, or auth.session.reuse. Rotation happens silently per request, and a superseded-token replay or a stolen pre-rotation secret presented after rotation produces no event, log, or hook — a reuse-detection layer (RRS-003) would have nothing to subscribe to and an operator has no way to notice a token-family compromise in progress. The registry's own header (AuthEvents.ts:6-13) says tags grow as real publishers appear; none exist for sessions.

## Evidence

Source: `packages/core/src/AuthEvents.ts:24`

```
export interface TokenReplayEvent {
  readonly _tag: "auth.token.replay";
  readonly identifier: string;
}
```

## Recommended fix

Add auth.session.rotated (published on the winning CAS rotation write) and auth.session.reuse (published on tombstoned-token replay) as the first session tags, giving the future detection layer an event to consume and operators an audit trail.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-event-taxonomy`. Already fixed by commit 9017a8a. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:68`. Fix: Publish session lifecycle events from Sessions itself (both layers), not per plugin. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
