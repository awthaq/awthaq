---
ID: "TRBS-003"
Title: "Bounded AuthEvents PubSub suspends publishers; replay events can hang consume"
Level: high
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:263"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-003 — Bounded AuthEvents PubSub suspends publishers; replay events can hang consume

`HIGH` · `correctness` · `core` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

The event bus that carries `auth.token.replay` (and every sign-in/impersonation event) is a bounded(1024) PubSub whose `publish` suspends when capacity is reached — there is no drop, no timeout, no drain guarantee. A subscription only exists if the application installs an `AuthEvents.on(...)` layer, and grep shows `on` used only under packages/core/test; the shipped example (examples/memory-server/index.ts:70) merges `AuthEvents.layer` with no subscriber, so nothing ever consumes from the PubSub. After 1024 undrained events, `Verification.consume`'s failure path — `Effect.tapError(() => events.publish(...))` at Verification.ts:314-315 — suspends indefinitely instead of returning TokenConsumed, and password sign-in publishing `auth.user.signedIn` hangs the same way. Replay detection (INV-EA-010) becomes a self-DoS under exactly the probing attack it exists to signal.

## Evidence

Source: `packages/core/src/AuthEvents.ts:263`

```
const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Pick an explicit backpressure policy: publish with a bounded wait then drop with a logged `auth.event.dropped` marker, or use PubSub.dropping. At minimum, ship a default-drain subscriber (forkScoped runForEach that logs) inside `AuthEvents.layer` so the bus always drains even when the app installs no handlers.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — same root cause as TMS-002 (`AuthEvents.ts:263-265` matches evidence exactly; `PubSub.bounded` suspends publishers when full per effect's own docs). Confirmed further: `AuthEvents.on` is used only in `packages/core/test/AuthEvents.test.ts:69`, and `examples/memory-server/index.ts:70` merges `AuthEvents.layer` with no subscriber installed. `Verification.ts:314-315`'s `Effect.tapError(() => events.publish(...))` is real and matches the failure path described. Choosing the backpressure/default-subscriber policy is a design decision (see TMS-002). Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [AuthEvents PubSub backpressure / never-suspend contract](../../.scratch/resolve-ready-for-human-findings/issues/02-pubsub-backpressure-contract.md) — `PubSub.dropping` replaces `PubSub.bounded`; no mandatory default-drain subscriber needed since dropping (not durability) is now the correct, non-suspending fallback with a logged `auth.event.dropped` signal. Status → ready-for-agent.

**Resolved (2026-09-19):** `AuthEvents.layer` now builds its bus with `PubSub.dropping(CAPACITY)` instead of `PubSub.bounded(CAPACITY)` — the same bounded-memory guarantee (BEH-EA-097), but `PubSub.publish` never suspends the calling fiber (BEH-EA-098 actually holds now, for every one of the 34+ inline hot-path publish sites: signIn/signUp, token-replay, OAuth callback, organization mutations, etc.). Silent loss is made observable rather than merely possible: `AuthEventsShape` gained `droppedCount: Effect.Effect<number>`, and every dropped publish also logs a warning naming the event's own `_tag`. Added a capacity-stress regression test (a subscriber that registers, takes one event, then stalls forever — the exact lagging-consumer shape an audit/SIEM sink is) publishing past capacity: confirmed this genuinely hung for the full 5s test timeout against the old `PubSub.bounded` code (a temporary revert + re-apply), and now completes near-instantly with the overflow correctly counted as dropped. `AuthEvents.on`'s "ship a default-drain subscriber inside `AuthEvents.layer`" (TRBS-003's secondary suggestion) is left out of scope: `PubSub.dropping` no longer depends on a subscriber existing at all to avoid publisher suspension, and the `droppedCount`/log-warning pair already makes total silent loss (zero installed subscribers) observable without opinionated default behavior a real deployment may not want. Full `@awthaq/core` suite (109 tests), BDD suite, and monorepo typecheck pass. Status → resolved.
