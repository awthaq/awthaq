---
ID: "ALF-007"
Title: "on() subscriptions attach asynchronously — events published during startup are silently lost"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:298"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-007 — on() subscriptions attach asynchronously — events published during startup are silently lost

`MEDIUM` · `correctness` · `core` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

on() forks the drain fiber, so the underlying PubSub subscription registers only when that fiber is first scheduled; a sign-in racing application boot publishes its event to nobody, and the bus is a live broadcast with no replay, so the loss is unrecoverable and — worse for audit semantics — undetectable. The repo keeps re-discovering this: core's own test sleeps 20ms hoping to lose the race (AuthEvents.test.ts:81), and the BDD harness works around it with forkScoped({ startImmediately: true }) plus a comment citing "exactly this race" (AdminWorld.ts:70-73). A consumer who trusts the sugar gets a silently incomplete trail at exactly the moment (startup, deploy) when incidents are often staged.

## Evidence

Source: `packages/core/src/AuthEvents.ts:298`

```
        Effect.forkScoped,
      );
```

## Recommended fix

Register the subscription synchronously during Layer build before forking the drain loop, or back the bus with a replay-capable PubSub so late-attaching subscribers receive recent events; the fix should remove the need for every consumer to know the fork-scheduling caveat.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-006` — Event payloads carry no timestamp, correlation id, or source context](medium/ALF-006-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-009` — PII rides the bus with no subscription access control or redaction](low/ALF-009-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CWM-004` — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto](medium/CWM-004-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-events-subscription`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:405`. Fix: Register the PubSub subscription synchronously during the subscription Layer's build, then fork the drain loop over that already-registered subscription. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** AuthEventsShape.subscribe registers the PubSub subscription synchronously in the caller's Scope; on()/onBatch register it while the subscription Layer builds and then fork the drain over the registered stream. stream stays lazy (documented). Tests: AuthEvents.test.ts 'on(): an event published right after the Layer is built is delivered' as it.effect with a Queue and no sleeps (the old it.live + 20ms sleep test is gone).
