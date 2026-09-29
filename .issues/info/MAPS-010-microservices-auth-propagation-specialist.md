---
ID: "MAPS-010"
Title: "No cross-process event channel - revocation can never be pushed to other services"
Level: info
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:263"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-010 — No cross-process event channel - revocation can never be pushed to other services

`INFO` · `architecture` · `core` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

AuthEvents is a bounded in-process PubSub (capacity 1024). That is a sound design for its stated purpose, but it means the event-driven revocation-invalidation strategy my persona would reach for - 'session killed via admin -> publish -> every verifier drops cached identity' - is structurally impossible across processes today. Combined with MAPS-002, a multi-replica or multi-service deployment has no mechanism (pull or push) to learn of a revocation faster than the token TTL. No mTLS, trusted-proxy header handling (x-forwarded-*), or mesh-specific affordance exists anywhere in packages/server; the canonical deployment shape (examples/memory-server/index.ts) is a single Node process on plain HTTP.

## Evidence

Source: `packages/core/src/AuthEvents.ts:263`

```
const pubsub = yield* PubSub.bounded<AuthEvent>(CAPACITY);
```

## Recommended fix

If multi-service operation is a goal, expose an outbox-style AuthEvents transport seam (application-provided Layer) so a Redis/Kafka/WebSocket fanout can be installed without touching core; otherwise state the single-process assumption explicitly in spec/overview.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `auth-event-external-delivery`. Duplicate of `CWM-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:376`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
