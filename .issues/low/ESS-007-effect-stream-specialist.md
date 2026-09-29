---
ID: "ESS-007"
Title: "Every subscriber filters all 25 event types itself; no per-tag channel for the one-tag-one-handler case"
Level: low
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:285"
Auditor: "effect-stream-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-007 — Every subscriber filters all 25 event types itself; no per-tag channel for the one-tag-one-handler case

`LOW` · `architecture` · `core` · reported by **Effect Stream Specialist** (`effect-stream-specialist`)

Status: **resolved**

## Summary

AuthEvent is a 25-member closed union (AuthEvents.ts:213-238), and each on(tag, ...) Layer subscribes to the single shared PubSub and discards every event not matching its tag. Fan-out cost per published event grows linearly with the number of subscription Layers — 20 organization-event tags invite many such Layers — so a deployment with per-tag alerting subscribers pays O(events x subscribers) wakeups, with each subscriber's filter allocating nothing but still pulling every payload through its fiber. Correct today, but the registry's own growth path (BEH-EA-101: 'a plugin author can add a new event tag') scales the tax.

## Evidence

Source: `packages/core/src/AuthEvents.ts:285`

```
        Stream.filter((event): event is Extract<AuthEvent, { readonly _tag: Tag }> =>
          Object.is(event._tag, tag),
        ),
```

## Recommended fix

Keep the shared bus, but consider offering partitioned reads (per-tag derived PubSubs, or Stream.partition on the union's _tag) for multi-subscriber deployments; document the fan-out characteristic on AuthEventsShape.stream so consumers needing several tags use one raw-stream subscription (BEH-EA-102) instead of N sugar Layers.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `auth-events-subscription`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:398`. Fix: Let `on`/`onBatch` accept a tag array (one subscription, narrowed union type) and document the fan-out characteristic on `stream`; do not build per-tag PubSubs (speculative). (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** on()/onBatch accept a tag or an array of tags (one subscription, handler typed as the narrowed union, membership via a Set type guard, no assertion); stream/on docs state each consumer is a full subscriber. Test: on([a,b], h) delivers both tags and nothing else.
