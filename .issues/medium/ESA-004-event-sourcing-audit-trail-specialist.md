---
ID: "ESA-004"
Title: "Bounded PubSub means publish can suspend the auth operation; with zero subscribers the shipped example wedges on the 1025th event"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:264"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-004 — Bounded PubSub means publish can suspend the auth operation; with zero subscribers the shipped example wedges on the 1025th event

`MEDIUM` · `correctness` · `core` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **resolved**

## Summary

Publishes happen inline in request paths (packages/password/src/Password.ts:495 and :560; Passkey.ts:589; Organization.ts throughout). BEH-EA-098 requires publish to 'return once the event is enqueued, regardless of how many subscribers exist or how long they take', but a bounded PubSub backpressures publishers once its 1024 slots (CAPACITY, AuthEvents.ts:258) fill — a lagging subscriber slows every sign-in, and a deployment with no subscriber at all (exactly what examples/memory-server/index.ts:70 ships: the layer is provided, nothing consumes the stream) suspends the 1025th sign-in indefinitely. The BEH-EA-097/098 tension (bounded queue vs never-suspend) is resolved by no drop/shed policy in code and is not even acknowledged in the spec text.

## Evidence

Source: `packages/core/src/AuthEvents.ts:264`

```
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Pick and document an explicit overflow policy: either publish with a timeout that drops plus increments a dropped-events counter (observable via auth.event.observer.error-style telemetry), or publish into an unbounded-with-sink-drain shape where the durable table write, not the bus, is the ordering point. At minimum, ship one default durable sink so the zero-subscriber configuration cannot occur by accident.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 4b48cb2. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:363`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
