---
ID: "SCP-006"
Title: "Closed AuthEvent union has zero deactivation/deletion events, blocking offboarding propagation and audit"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:212"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-006 — Closed AuthEvent union has zero deactivation/deletion events, blocking offboarding propagation and audit

`MEDIUM` · `architecture` · `core` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

The union holds 25 event types including auth.user.created and rich organization member/role/team events, but no auth.user.deactivated or auth.user.deleted — and BEH-EA-101 declares the set closed, so a SCIM plugin cannot publish its most important lifecycle event (the persona's core concern: deprovisioning events propagating reliably and promptly) without modifying core. Offboarding would be invisible to audit subscribers and downstream session-cache invalidators, and the event that does exist for a related flow (OrganizationMemberRemoved) covers org-level, not directory-level, offboarding.

## Evidence

Source: `packages/core/src/AuthEvents.ts:212`

```
/** BEH-EA-101: the closed, statically-known set of event types `AuthEvents` carries today. */
export type AuthEvent =
  | TokenReplayEvent
```

## Recommended fix

Extend the union with user.deactivated and user.deleted events (published by the future SCIM plugin and by any admin suspension path), or define the sanctioned core-extension mechanism for plugin lifecycle events before Phase 3.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `auth-event-taxonomy`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:279`. Fix: Add `auth.user.deleted` now (published after the deletion transaction commits); add `auth.user.deactivated`/`reactivated` together with ticket 09's deactivation state. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** auth.user.deleted { userId, deletedBy } added (no email) and published by Account.deleteUser after the deletion transaction commits (a rolled-back deletion publishes nothing). Test: packages/server/test/AuthHttp.test.ts DELETE /user asserts exactly one audit row. auth.user.deactivated/reactivated stay with ticket 09's deactivation state (P14); the publish moves into the core erasure service with CSG-001 (P11).
