---
ID: "CWM-004"
Title: "No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto"
Level: medium
Category: "architecture"
Status: ready-for-human
Package: "core"
Source: "packages/core/src/AuthEvents.ts:293"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-004 — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto

`MEDIUM` · `architecture` · `core` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **ready-for-human**

## Summary

Clerk's integration contract is signed webhooks (svix) for user/organization/membership events; almost every Clerk app has a webhook receiver. effect-auth's equivalent vocabulary is excellent — 18 typed auth.organization.* event tags (packages/core/src/AuthEvents.ts:83-209) — but delivery is an in-memory PubSub with in-process observers logging observer failures; grep for 'webhook' across packages/ returns nothing. There is no outbound HTTP delivery, no payload signing, no retry/dead-letter, and because AuthEvents is in-memory, events do not survive restarts and do not cross process boundaries. A migration must either move the consumer into the auth process (in-process subscribe) or build a custom bridge. The HookPoint veto/observe layer (packages/organization/src/OrganizationHooks.ts, 36 points) is a genuinely good authoring seam for exactly such a bridge, which keeps this at medium rather than high.

## Evidence

Source: `packages/core/src/AuthEvents.ts:293`

```
Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
```

## Recommended fix

Ship or specify a WebhookSink port (signed payload, bounded retries, delivery per event-type subscription) as an opt-in plugin, or at minimum document the supported in-process recipe — subscribe AuthEvents in the host application's composition — as the official Clerk-webhook replacement path, so migrators do not hand-roll an unauthenticated outbox.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-006` — Event payloads carry no timestamp, correlation id, or source context](medium/ALF-006-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-007` — on() subscriptions attach asynchronously — events published during startup are silently lost](medium/ALF-007-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-009` — PII rides the bus with no subscription access control or redaction](low/ALF-009-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-event-external-delivery`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:376`. Fix: Per decision D2: build an outbox relay over auth_audit_log and an opt-in webhooks plugin on top of it; document the in-process recipe meanwhile. (effort XL). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-human.
