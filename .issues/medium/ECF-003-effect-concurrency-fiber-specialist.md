---
ID: "ECF-003"
Title: "Bounded AuthEvents PubSub suspends publishers — sign-in can block behind a slow subscriber"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:263"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-003 — Bounded AuthEvents PubSub suspends publishers — sign-in can block behind a slow subscriber

`MEDIUM` · `correctness` · `core` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

signIn/signUp publish auth.user.signedIn/created synchronously on the request path (Password.ts:495, 560). On a full bounded PubSub, Effect v4's publish calls strategy.handleSurplus, which parks the publisher on a Deferred until subscribers drain (verified in effect@4.0.0-rc.116 PubSub.ts handleSurplus). With CAPACITY=1024 the headroom is large, but the coupling is structural: one subscriber fiber stuck in a handler that itself makes an unbounded outbound call (per ECF-001) eventually backpressures every sign-in in the process. The bounded choice is documented as intentional slow-subscriber protection, but the protection currently transfers the stall to publishers rather than dropping.

## Evidence

Source: `packages/core/src/AuthEvents.ts:263`

```
const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Keep the hot path non-blocking: either publish from a forked fiber whose failure is logged, or switch the overflow policy (dropping/sliding strategy or an unbounded queue with a capacity alarm) so a wedged subscriber degrades event delivery, never authentication latency. Add a load test that wedges one subscriber and asserts signIn latency.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 4b48cb2. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:363`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
