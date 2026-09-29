---
ID: "ESA-007"
Title: "Events are plain TypeScript interfaces: no version field, no runtime codec, no evolution path toward durability"
Level: low
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuthEvents.ts:213"
Auditor: "event-sourcing-audit-trail-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESA-007 — Events are plain TypeScript interfaces: no version field, no runtime codec, no evolution path toward durability

`LOW` · `architecture` · `core` · reported by **Event Sourcing & Audit Trail Specialist** (`event-sourcing-audit-trail-specialist`)

Status: **ready-for-agent**

## Summary

The registry is a closed TS union of plain interfaces — compile-time checked only. The repo's own recommendation was event contracts 'typed via Schema' (research/01-effect-ecosystem.md:140), which the rest of the persistence stratum follows (Models.ts, ImpersonationRow all use Effect Schema). Without a version discriminant and encode/decode, the first durable or cross-process consumer must invent upcasting for shapes that have already changed, and there is no story for reading old rows after a payload evolves — the exact red flag (no schema-evolution plan) the hiring rubric screens for.

## Evidence

Source: `packages/core/src/AuthEvents.ts:213`

```
export type AuthEvent =
  | TokenReplayEvent
```

## Recommended fix

Promote the event payload definitions to Schema.Struct declarations with an explicit version field (even constant 1), placed so both the in-memory bus and the future SQL sink decode through one codec. This also gives the audit table typed row schemas for free, matching ImpersonationRow's precedent.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: event durability & audit
- Full dossier: [`event-sourcing-audit-trail-specialist`](../../.reports/event-sourcing-audit-trail-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-event-schema`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:279`. Fix: Define every AuthEvent as an Effect Schema (TaggedStruct) with a `version` literal, derive the TS types from the schemas, and decode AuditLog payloads through the union codec. (effort L). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
