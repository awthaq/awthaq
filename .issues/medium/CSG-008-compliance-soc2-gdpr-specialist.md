---
ID: "CSG-008"
Title: "Breach-detection signals are published but never consumed by any pipeline"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:45"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-008 — Breach-detection signals are published but never consumed by any pipeline

`MEDIUM` · `security` · `core` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

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

**Resolved (2026-09-29):** Opt-in SecuritySignals detector, packages/core/src/SecuritySignals.ts, exported from @awthaq/core. One multi-tag AuthEvents.on subscription (race-free, supervised) over the tags a configured rule names; a sliding window per (rule, key) over the envelope's occurredAt (TestClock-controllable); an incident when a rule's threshold is reached inside its window, after which the bucket restarts so a sustained attack raises one incident per threshold events. Default rules (SecuritySignals.defaultRules, replaceable via SecuritySignals.config({ rules, maxBuckets })): session.reuse >=1 (per user, high), passkey.counterAnomaly >=1 (per credential, high), token.replay 5 per identifier / 10 min (medium; the incident never names the identifier since it can be a mailbox), signIn.failedByAddress 10 per clientIp / 10 min and signIn.failedByIdentifier 5 per identifierDigest / 10 min (medium; uses the ESA-005 digest and clientIp, no oracle), admin.impersonationDenied 3 per admin / 10 min (high). SecuritySignals.rule builds a rule over one tag with a key selector typed to that tag (no assertion). Incidents are reported by a warning log `auth.security.incident`, the existing awthaq_security_incident_total{rule} counter, and the IncidentSink Context.Reference (default no-op) an app backs with a table/pager; a sink that fails is logged (auth.security.sink.error) and never stops detection. The bucket table is bounded (maxBuckets, expired first then least recently seen). Tests: packages/core/test/SecuritySignals.test.ts (10 cases under TestClock: single counter anomaly raises, session reuse, N replays raise one incident and N-1 do not, window sliding, per-key buckets, sustained attack cadence, address vs digest independence, per-admin denials, custom rules replace defaults, failing sink, bounded buckets). Spec: As-shipped paragraph on BEH-EA-103 (13-events.md), README 'Detecting attacks', examples/memory-server opts in. Decision noted: incidents are not re-published as an AuthEvent (the sink is where an app records them durably); detection runs over the bus's at-most-once delivery, the durable trail stays AuditLog.
