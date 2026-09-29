---
ID: "MA-009"
Title: "Bounded AuthEvents PubSub converts event saturation into stalled authentication requests"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:263"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-009 — Bounded AuthEvents PubSub converts event saturation into stalled authentication requests

`MEDIUM` · `correctness` · `core` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **ready-for-agent**

## Summary

The bounded capacity (1024) with BackPressureStrategy is deliberate and spec'd (13-events.feature: 'it is not PubSub.unbounded'), but the pairing with the publish signature misses the semantic consequence: bounded PubSub.publish suspends the publishing fiber once the buffer is full (verified in the installed effect's PubSub.ts BackPressureStrategy: the surplus handler parks on Deferred.await). Verification.consume and every Password sign-up/sign-in publish onto this bus on the request path; with no AuthEvents.on subscriber installed (the default in TestAuth.layer and examples/memory-server — nothing there provides a subscriber), the buffer drains never, and after 1024 published events every subsequent sign-in/sign-up/token-consumption stalls indefinitely. The shape's own doc ('returns once the event is enqueued — never suspends on a subscriber') is true below saturation and false at it, which is the only regime a bounded-but-undrained buffer creates. The memory-safety goal is right; the failure mode chosen for it is request-liveness.

## Evidence

Source: `packages/core/src/AuthEvents.ts:263`

```
    const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Either document and bound the blast radius (default subscriber that drains to a no-op/log sink, always provided by TestAuth.layer and recommended in the README), or make the tradeoff explicit and configurable (PubSub.sliding/dropping preserves liveness and only loses telemetry), and correct the BEH-EA-098 wording to state the saturation behavior.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-events-subscription`. Already fixed by commit 4b48cb2. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:363`. Fix: Apply wayfinder ticket 02's BEH-EA-098 rewording and document the dropping/droppedCount semantics in BEH-EA-097. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
