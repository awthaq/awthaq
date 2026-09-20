---
ID: "EP-002"
Title: "AuthEvents is a volatile in-process PubSub with no durable sink shipped anywhere"
Level: high
Category: "compliance"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:258"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-002 — AuthEvents is a volatile in-process PubSub with no durable sink shipped anywhere

`HIGH` · `compliance` · `core` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

The event vocabulary is excellent (25 event tags covering organization, membership, invitation, team, role, and impersonation lifecycle), but delivery is `PubSub.bounded(1024)` — publish 'returns once the event is enqueued' (AuthEvents.ts:241), nothing persists, and a grep across packages/ finds zero production subscribers: only test files consume `events.stream`. A process restart silently erases the audit trail; SOC 2 / ISO 27001 evidence for 'who created, removed, or role-changed whom' does not exist. For a security-critical library this is the compliance gap an enterprise buyer hits first.

## Evidence

Source: `packages/core/src/AuthEvents.ts:258`

```
const CAPACITY = 1024;

export const layer: Layer.Layer<AuthEvents> = Layer.effect(
```

## Recommended fix

Ship a durable sink as a first-class Layer: an append-only auth_event table (plugin-owned, following the admin_impersonation pattern) written by an `AuthEvents.on`-style subscriber, plus query/export endpoints and retention configuration. Keep the PubSub for realtime consumers, but durability must not depend on an application remembering to subscribe.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

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

**Decision (2026-09-19):** Resolved via [Durable audit/event trail sink architecture](../../.scratch/resolve-ready-for-human-findings/issues/01-durable-audit-event-sink.md) — new `AuditLog` core service, backed by a new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` itself (a hard `AuthEvents.layer` dependency, not an opt-in subscriber), covering all 25 registry event tags; the `PubSub` remains for realtime consumers as suggested. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/core/src/AuthEvents.ts:258` exactly (`const CAPACITY = 1024;` immediately preceding the `Layer.effect` line cited); `grep -rn "events\.stream" packages/*/src` finds only the module's own internal `on()` helper, no production subscriber, and the durable `admin_impersonation` table is written directly by `@awthaq/admin`, not via an `AuthEvents` subscription. Shipping a durable, SOC2-grade audit sink (schema, retention policy, export API) is a genuine architecture/compliance decision, not a narrow patch. Status → ready-for-human.

**Resolved (2026-09-20):** Duplicate of [`ALF-001`](ALF-001-audit-logging-forensics-specialist.md) (same underlying gap, same wayfinder decision ticket). A new `AuditLog` core service now exists (`packages/core/src/AuditLog.ts`), backed by the new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` as a hard `AuthEvents.layer` dependency (not an opt-in subscriber), covering all 27 registry event tags; the `PubSub` remains available for realtime consumers, exactly as this finding's own recommended fix asked. See `ALF-001`'s own resolution comment for full implementation and verification detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
