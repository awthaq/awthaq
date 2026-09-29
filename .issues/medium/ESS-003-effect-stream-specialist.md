---
ID: "ESS-003"
Title: "Subscription-attach race in AuthEvents.on: events published before the forked subscriber registers are silently lost"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:298"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-003 — Subscription-attach race in AuthEvents.on: events published before the forked subscriber registers are silently lost

`MEDIUM` · `correctness` · `core` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **resolved**

## Summary

on() forks the subscription with plain Effect.forkScoped, so the PubSub subscription registers only when the forked fiber is first scheduled — between Layer construction and that first pull, published events go to nobody. Stream.fromPubSub is a live broadcast, not a replay log (its doc shows late subscribers receiving only subsequently published values). The BDD harness hit this as 'a live broadcast, not a replay log, so a missed publish is gone for good. Real, reproduced bug (an empty publishedEvents() after a real impersonate call)' (features/step-definitions/AdminWorld.ts:66-68) and works around it by passing startImmediately: true; packages/core/test/AuthEvents.test.ts:24 does the same. Production consumers of on() get no such option, so the sugar's documented guarantee ('establishes a subscription') is racy at startup. Note effect v4's PubSub.bounded supports a replay buffer for exactly this ({capacity, replay}).

## Evidence

Source: `packages/core/src/AuthEvents.ts:298`

```
        Stream.runForEach((event) =>
          handler(event).pipe(
```

## Recommended fix

Make on() race-free: subscribe synchronously during Layer build before forking the drain loop, or back the bus with PubSub.bounded({capacity: CAPACITY, replay: n}) so late-attaching subscribers replay recent events; either way remove the need for each consumer to know the fork-scheduling caveat.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `auth-events-subscription`. Duplicate of `ALF-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:405`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
