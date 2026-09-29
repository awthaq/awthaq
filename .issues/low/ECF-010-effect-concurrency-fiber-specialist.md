---
ID: "ECF-010"
Title: "Event subscription fibers have no restart policy"
Level: low
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:298"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-010 — Event subscription fibers have no restart policy

`LOW` · `architecture` · `core` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

AuthEvents.on binds each subscription's lifetime to its Layer scope via forkScoped (correct — no leak), and per-event handler failures are caught and logged so a bad event cannot kill the stream (AuthEvents.ts:291-297, backed by AuthEvents.test.ts:39-64). But the subscription fiber itself has no supervision: if the runForEach fiber dies from a defect outside the handler (e.g. a runtime-level failure while polling the PubSub), event delivery — including auth.token.replay, the replay-detection signal — silently ends for the process lifetime with no restart and no health signal.

## Evidence

Source: `packages/core/src/AuthEvents.ts:298`

```
        Effect.forkScoped,
      );
```

## Recommended fix

Restart the subscription with a bounded retry (Stream.retry or forkDaemon + repeat on defect with backoff), or expose subscription liveness so operators can alert on a dead audit stream.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `auth-events-subscription`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:405`. Fix: Supervise each `on()` subscription: log when the drain fiber ends for any reason other than scope close, and resubscribe with bounded backoff. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** on()/onBatch supervise their drain fiber: if it ends for any reason other than the Layer's scope closing it is logged as auth.event.subscription.died (sanitized) and resubscribed with bounded exponential backoff (Schedule.min of exponential 100ms and spaced 30s); awthaq_event_subscriptions_active gauge tracks live drains. Test: a fake bus whose first subscription dies (Stream.die) is resubscribed, delivers, and logs the death.
