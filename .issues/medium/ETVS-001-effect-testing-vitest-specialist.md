---
ID: "ETVS-001"
Title: "Real wall-clock sleeps in the AuthEvents subscription test"
Level: medium
Category: "testing"
Status: resolved
Package: "core"
Source: "packages/core/test/AuthEvents.test.ts:81"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-001 — Real wall-clock sleeps in the AuthEvents subscription test

`MEDIUM` · `testing` · `core` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **resolved**

## Summary

The only genuine wall-clock dependency in the unit suite: this it.live case sleeps 20ms twice (lines 81 and 84) to give the subscription Layer's internally forked fiber time to subscribe before publishing. Fixed 20ms races are exactly the flake class this repo otherwise eliminates - a loaded CI machine can miss the subscribe window, and the test costs 40ms of real time per run. The comment correctly identifies the cause ('on's public signature has no such knob' for startImmediately).

## Evidence

Source: `packages/core/test/AuthEvents.test.ts:81`

```
// signature has no such knob) a chance to actually subscribe.
      yield* Effect.sleep("20 millis");
      yield* events.publish({ _tag: "auth.user.signedIn", userId, strategy: "password" });
```

## Recommended fix

Make the handshake deterministic instead of timed: publish a first 'probe' event and wait on a Dequeue/Latch that the subscriber's own first invocation settles (proves subscription), or add an internal startImmediately-capable variant of AuthEvents.on for tests. Keep it.live only if a latch is impossible, but never assert on a fixed 20ms window.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-events-subscription`. Evidence at HEAD ec065a7: `packages/core/test/AuthEvents.test.ts:112`. Fix: Once ALF-007 makes `on()` register synchronously, rewrite the test as `it.effect` with a handler-completed Deferred/Queue instead of sleeps. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** The BEH-EA-103 test is rewritten as it.effect with Queue.take, no sleeps (grep 'it.live\|sleep("20 millis")' packages/core/test/AuthEvents.test.ts is empty).
