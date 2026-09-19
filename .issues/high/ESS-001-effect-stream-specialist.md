---
ID: "ESS-001"
Title: "events.publish suspends the publishing fiber at capacity, violating BEH-EA-098's publisher-never-awaits invariant"
Level: high
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:263"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-001 — events.publish suspends the publishing fiber at capacity, violating BEH-EA-098's publisher-never-awaits invariant

`HIGH` · `correctness` · `core` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **resolved**

## Summary

BEH-EA-098 requires: 'Publishing an event to AuthEvents MUST NOT suspend the publishing fiber... publish MUST return once the event is enqueued.' The implementation uses PubSub.bounded, whose own framework documentation states: 'When the capacity is full, publishers suspend until space is available' (effect 4.0.0-rc.116 src/Pubsub.ts:297-303). A subscriber that lags — e.g. AuthEvents.on running a slow SIEM/SQL write via runForEach, one event at a time — lets the 1024-slot buffer fill, after which every publish blocks. All 34 publish sites are inline in request paths: Verification.consume publishes auth.token.replay on failure (packages/core/src/Verification.ts:224), Password.signIn publishes auth.user.signedIn (packages/password/src/Password.ts:560), OAuth's callback publishes inside user creation (packages/oauth/src/OAuth.ts:718). A stalled or absent consumer therefore stalls sign-ins, token consumption, and organization mutations — the exact coupling BEH-EA-098 exists to forbid. Sliding/dropping strategies would still satisfy BEH-EA-097's bounded-capacity requirement.

## Evidence

Source: `packages/core/src/AuthEvents.ts:263`

```
const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Switch to PubSub.sliding(CAPACITY) or PubSub.dropping(CAPACITY) (still bounded, so BEH-EA-097's memory bound and REQ-EA-260's backlog bound hold) so publishers never suspend; optionally pair with a dropped-event counter/metric so silent loss is observable. Add a capacity-stress test: fill the buffer against a never-catching-up subscriber and assert publish returns without suspending — this is precisely BDD scenarios REQ-EA-261/262.

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

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/AuthEvents.ts:263-264` still constructs `PubSub.bounded<AuthEvent>(CAPACITY)` and `publish = (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid)`; effect's own `Pubsub.ts:303` documents "When the capacity is full, publishers suspend until space is available." All cited publish call sites (`Verification.ts:224`, `Password.ts:560`, `OAuth.ts:718/730`) are confirmed inline in request paths. Swapping to `PubSub.sliding`/`PubSub.dropping` is a bounded, mechanical change. Status → ready-for-agent.

**Resolved (2026-09-19):** `AuthEvents.layer` now builds its bus with `PubSub.dropping(CAPACITY)` instead of `PubSub.bounded(CAPACITY)` — the same bounded-memory guarantee (BEH-EA-097), but `PubSub.publish` never suspends the calling fiber (BEH-EA-098 actually holds now, for every one of the 34+ inline hot-path publish sites: signIn/signUp, token-replay, OAuth callback, organization mutations, etc.). Silent loss is made observable rather than merely possible: `AuthEventsShape` gained `droppedCount: Effect.Effect<number>`, and every dropped publish also logs a warning naming the event's own `_tag`. Added a capacity-stress regression test (a subscriber that registers, takes one event, then stalls forever — the exact lagging-consumer shape an audit/SIEM sink is) publishing past capacity: confirmed this genuinely hung for the full 5s test timeout against the old `PubSub.bounded` code (a temporary revert + re-apply), and now completes near-instantly with the overflow correctly counted as dropped. `AuthEvents.on`'s "ship a default-drain subscriber inside `AuthEvents.layer`" (TRBS-003's secondary suggestion) is left out of scope: `PubSub.dropping` no longer depends on a subscriber existing at all to avoid publisher suspension, and the `droppedCount`/log-warning pair already makes total silent loss (zero installed subscribers) observable without opinionated default behavior a real deployment may not want. Full `@awthaq/core` suite (109 tests), BDD suite, and monorepo typecheck pass. Status → resolved.
