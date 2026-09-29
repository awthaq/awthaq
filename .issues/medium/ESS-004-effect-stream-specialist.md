---
ID: "ESS-004"
Title: "No batching or buffering stage anywhere — the designed heavy sinks write one event per round trip"
Level: medium
Category: "performance"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:291"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-004 — No batching or buffering stage anywhere — the designed heavy sinks write one event per round trip

`MEDIUM` · `performance` · `core` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **ready-for-agent**

## Summary

The persona-relevant workloads — batched SQL inserts of audit events, SIEM export, admin batched exports — all need grouped writes, but the repo's only consumer shape is runForEach over single events, and grep of packages/ shows zero uses of Stream.grouped, Stream.groupedWithin, Stream.buffer, Stream.rechunk, or Stream.batched (all available in effect 4.0.0-rc.116's Stream.ts:14502/14594/7341/12210). One SQL insert per published auth event is the classic N-round-trip pattern the batching operators exist to prevent, and without Stream.buffer there is no tolerated burst between a fast producer and a slow sink other than the bus's own 1024 slots.

## Evidence

Source: `packages/core/src/AuthEvents.ts:291`

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
```

## Recommended fix

Establish a canonical batched-consumer pattern (e.g. events.stream.pipe(Stream.groupedWithin(100, '1 second'), Stream.mapEffect(bulkInsert))) in the durable AuditLog layer (see ESS-002) and reference it from the spec's usage examples so plugin authors copy it instead of runForEach.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Stream & backpressure
- Full dossier: [`effect-stream-specialist`](../../.reports/effect-stream-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `auth-events-subscription`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:363`. Fix: Add a batched-subscription sugar next to `on()` and document it as the pattern for secondary sinks. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
