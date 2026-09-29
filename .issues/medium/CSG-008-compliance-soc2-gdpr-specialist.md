---
ID: "CSG-008"
Title: "Breach-detection signals are published but never consumed by any pipeline"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:45"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-008 — Breach-detection signals are published but never consumed by any pipeline

`MEDIUM` · `security` · `core` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **ready-for-agent**

## Summary

Genuine detection signals exist - passkey counter anomalies (a cloned-authenticator indicator), verification-token replays, admin impersonation denials - but each is only published to the ephemeral bus, and for the counter anomaly the event itself is documented as 'the whole response to the anomaly'. No code counts occurrences, applies thresholds, persists an incident, or alerts an operator; the HIBP breached-password check in the password plugin is opt-in and likewise feeds nothing downstream. Detection signals without a pipeline do not constitute breach-detection capability under SOC 2 CC7.2 or support GDPR Art. 33.

## Evidence

Source: `packages/core/src/AuthEvents.ts:45`

```
 * language, so the session still issues and this event is the whole
 * response to the anomaly, not a request-level failure.
```

## Recommended fix

Define a SecuritySignal subscriber in the server composition root that applies threshold rules over auth.token.replay and auth.passkey.counterAnomaly, persists an incident record, and surfaces it to operators (log sink minimum, admin API ideally).

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
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `security-signal-pipeline`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:108`. Fix: Ship an opt-in `SecuritySignals` subscriber layer that applies configurable threshold rules over the security tags and emits incidents (log + metric + optional incident sink port). (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
