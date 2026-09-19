---
ID: "ALF-002"
Title: "BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in"
Level: high
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:263"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-002 — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in

`HIGH` · `correctness` · `core` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

The shape contract at AuthEvents.ts:241 promises publish "never suspends on a subscriber", but Effect's bounded PubSub applies BackPressure: with a lagging consumer — exactly what an audit/SIEM sink writing to SQL is — the 1025th in-flight publish parks the publishing sign-in/verification fiber. The audit subsystem therefore has neither a bounded-latency nor a bounded-loss story: it can jam authentication outright, and there is no drop policy or dropped-event counter to make loss observable if the strategy is changed. This is also a DoS-shaped coupling between subscriber health and the auth hot path.

## Evidence

Source: `packages/core/src/AuthEvents.ts:263`

```
const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Switch to PubSub.sliding/dropping(CAPACITY) (still bounded, preserving BEH-EA-097) paired with a dropped-event counter/metric so silent loss is visible; add the REQ-EA-261/262 capacity-stress scenarios as an executable test against a never-catching-up subscriber.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
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

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/AuthEvents.ts:263-265` uses `PubSub.bounded<AuthEvent>(CAPACITY)`, exactly as quoted; Effect's bounded PubSub applies back-pressure by default, so a lagging subscriber does suspend the publishing fiber, contradicting the shape contract's "never suspends on a subscriber" comment at line 241. Swapping to `PubSub.sliding`/`dropping` plus a dropped-event counter is a well-scoped, mechanical change. Status → ready-for-agent.

**Resolved (2026-09-19):** `AuthEvents.layer` now builds its bus with `PubSub.dropping(CAPACITY)` instead of `PubSub.bounded(CAPACITY)` — the same bounded-memory guarantee (BEH-EA-097), but `PubSub.publish` never suspends the calling fiber (BEH-EA-098 actually holds now, for every one of the 34+ inline hot-path publish sites: signIn/signUp, token-replay, OAuth callback, organization mutations, etc.). Silent loss is made observable rather than merely possible: `AuthEventsShape` gained `droppedCount: Effect.Effect<number>`, and every dropped publish also logs a warning naming the event's own `_tag`. Added a capacity-stress regression test (a subscriber that registers, takes one event, then stalls forever — the exact lagging-consumer shape an audit/SIEM sink is) publishing past capacity: confirmed this genuinely hung for the full 5s test timeout against the old `PubSub.bounded` code (a temporary revert + re-apply), and now completes near-instantly with the overflow correctly counted as dropped. `AuthEvents.on`'s "ship a default-drain subscriber inside `AuthEvents.layer`" (TRBS-003's secondary suggestion) is left out of scope: `PubSub.dropping` no longer depends on a subscriber existing at all to avoid publisher suspension, and the `droppedCount`/log-warning pair already makes total silent loss (zero installed subscribers) observable without opinionated default behavior a real deployment may not want. Full `@awthaq/core` suite (109 tests), BDD suite, and monorepo typecheck pass. Status → resolved.
