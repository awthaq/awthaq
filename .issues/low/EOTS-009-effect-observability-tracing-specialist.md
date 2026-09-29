---
ID: "EOTS-009"
Title: "Event subscribers fork without trace linkage or annotations, detaching security events from the request that caused them"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:298"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-009 — Event subscribers fork without trace linkage or annotations, detaching security events from the request that caused them

`LOW` · `correctness` · `core` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **resolved**

## Summary

`AuthEvents.on` runs handlers on a `forkScoped` fiber (:298) reading a `Stream.fromPubSub`. Events are published mid-request (e.g. `auth.user.signedIn` inside the signIn handler), but once handled on the subscription fiber there is no recorded link — no span attribute, log annotation, or correlation field — tying the emitted event (and any observer-error log from it) back to the request span that produced it. For the persona's core scenario ('trace a single login flow across layer boundaries'), a security alert firing from `auth.token.replay` cannot be joined to the request trace that triggered it, and concurrent requests' events interleave with no discriminator. The isolation itself is correct per BEH-EA-099; only the correlation is missing.

## Evidence

Source: `packages/core/src/AuthEvents.ts:298`

```
        Stream.runForEach((event) =>
          handler(event).pipe(Effect.catchCause((cause) =>
```

## Recommended fix

Stamp events with a correlation id (e.g. the ambient span/trace id at publish time, or a request-scoped `Context.Reference` value folded into publish) so subscribers and their failure logs carry it.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `auth-event-envelope`. Duplicate of `ALF-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:405`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ALF-006-audit-logging-forensics-specialist` — closed by its fix (see that issue's Resolved comment).
