---
ID: "ARF-006"
Title: "Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:23"
Auditor: "account-recovery-flow-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ARF-006 — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook

`MEDIUM` · `architecture` · `core` · reported by **Account Recovery Flow Specialist** (`account-recovery-flow-specialist`)

Status: **ready-for-agent**

## Summary

The AuthEvents taxonomy carries organization invitations, impersonation start/stop/denied, and passkey counter anomalies — but nothing for the highest-value account transitions: reset requested, reset completed, password changed, email verified. confirmReset and changePassword publish no events at all, so an application cannot out-of-band notify the account owner that a recovery started or succeeded (the persona's strong-signal requirement), nor build an auditable trail beyond the single auth.token.replay event on failed consumes. Recovery — the most common real-world takeover vector — is the one domain with zero first-class observability.

## Evidence

Source: `packages/core/src/AuthEvents.ts:23`

```
export interface TokenReplayEvent {
  readonly _tag: "auth.token.replay";
  readonly identifier: string;
```

## Recommended fix

Add auth.password.resetRequested/resetCompleted and auth.password.changed events (userId, strategy) to AuthEvent, publish them from requestReset/confirmReset/changePassword, and document them as the application's hook for owner notification and SIEM export.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Account Recovery
- Full dossier: [`account-recovery-flow-specialist`](../../.reports/account-recovery-flow-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-006` — Event payloads carry no timestamp, correlation id, or source context](medium/ALF-006-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-007` — on() subscriptions attach asynchronously — events published during startup are silently lost](medium/ALF-007-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-009` — PII rides the bus with no subscription access control or redaction](low/ALF-009-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CWM-004` — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto](medium/CWM-004-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-event-taxonomy`. Already fixed by commit 45325bb. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:96`. Fix: Add and publish `auth.password.resetRequested` and `auth.user.emailVerified`. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
