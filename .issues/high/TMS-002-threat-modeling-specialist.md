---
ID: "TMS-002"
Title: "Bounded PubSub publish suspends when full, contradicting the documented never-suspend contract — sign-in hangs under event backpressure"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:264"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-002 — Bounded PubSub publish suspends when full, contradicting the documented never-suspend contract — sign-in hangs under event backpressure

`HIGH` · `architecture` · `core` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

The service contract states publish 'returns once the event is enqueued — never suspends on a subscriber' (line 241), but PubSub.publish on a bounded(1024) PubSub suspends when the buffer is full. Publishes sit directly on hot request paths — signIn emits auth.user.signedIn (Password.ts:560), signUp emits auth.user.created (Password.ts:495), and every failed token consumption emits auth.token.replay (Verification.ts:224). One slow or stuck AuthEvents.on subscriber (its handler runs serially in a single forEach) fills the buffer, and then every sign-in, sign-up, and token-verify request in the process suspends behind it: a remote, unauthenticated denial of service with no attacker-side rate limit, since failed-token events are free to mint (see TMS-010).

## Evidence

Source: `packages/core/src/AuthEvents.ts:264`

```
const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
    const publish: AuthEventsShape["publish"] = (event) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid);
```

## Recommended fix

Make publish genuinely non-blocking: either drop-oldest (PubSub with a sliding policy / publish on a forked fiber with a bounded queue), or surface backpressure as a typed error callers can ignore, and update the BEH-EA-098 documentation to match whichever semantics are chosen.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — evidence at `packages/core/src/AuthEvents.ts:263-265` matches exactly; effect's own `PubSub.bounded` docs (`node_modules/.../effect/src/PubSub.ts:297-303`) state "When the capacity is full, publishers suspend until space is available," directly contradicting the service doc's "never suspends" claim at line 241. `Password.ts:560`/`495` and `Verification.ts:224/315` all sit on this publish call. Choosing the backpressure policy (drop, typed error, or forced default subscriber) changes a documented contract (BEH-EA-098) and affects several other domains (replay detection, audit trail) — a design decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [AuthEvents PubSub backpressure / never-suspend contract](../../.scratch/resolve-ready-for-human-findings/issues/02-pubsub-backpressure-contract.md) — switch `AuthEvents`'s PubSub from `PubSub.bounded` to `PubSub.dropping`, safe now that ticket 1's `AuditLog` makes durability independent of this bus; publish never suspends, dropped events are logged/metered (`auth.event.dropped`). Status → ready-for-agent.

**Resolved (2026-09-19):** `AuthEvents.layer` now builds its bus with `PubSub.dropping(CAPACITY)` instead of `PubSub.bounded(CAPACITY)` — the same bounded-memory guarantee (BEH-EA-097), but `PubSub.publish` never suspends the calling fiber (BEH-EA-098 actually holds now, for every one of the 34+ inline hot-path publish sites: signIn/signUp, token-replay, OAuth callback, organization mutations, etc.). Silent loss is made observable rather than merely possible: `AuthEventsShape` gained `droppedCount: Effect.Effect<number>`, and every dropped publish also logs a warning naming the event's own `_tag`. Added a capacity-stress regression test (a subscriber that registers, takes one event, then stalls forever — the exact lagging-consumer shape an audit/SIEM sink is) publishing past capacity: confirmed this genuinely hung for the full 5s test timeout against the old `PubSub.bounded` code (a temporary revert + re-apply), and now completes near-instantly with the overflow correctly counted as dropped. `AuthEvents.on`'s "ship a default-drain subscriber inside `AuthEvents.layer`" (TRBS-003's secondary suggestion) is left out of scope: `PubSub.dropping` no longer depends on a subscriber existing at all to avoid publisher suspension, and the `droppedCount`/log-warning pair already makes total silent loss (zero installed subscribers) observable without opinionated default behavior a real deployment may not want. Full `@awthaq/core` suite (109 tests), BDD suite, and monorepo typecheck pass. Status → resolved.
