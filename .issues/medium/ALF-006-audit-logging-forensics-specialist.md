---
ID: "ALF-006"
Title: "Event payloads carry no timestamp, correlation id, or source context"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:35"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-006 — Event payloads carry no timestamp, correlation id, or source context

`MEDIUM` · `correctness` · `core` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

None of the 25 payload interfaces carries an occurrence timestamp, request/correlation id, actor IP, or user agent (Password.ts:144-148 documents that no client-IP extraction mechanism exists anywhere yet). A subscriber must stamp receive time, which under a queued broadcast bus can drift arbitrarily from the operation that produced the event, and two events from one request (a signedIn plus a replay probe, say) cannot be tied to each other or to the HTTP request that caused them. Incident reconstruction from these events cannot answer when exactly, from where, or same session — the three questions a timeline exists to answer.

## Evidence

Source: `packages/core/src/AuthEvents.ts:35`

```
export interface UserSignedInEvent {
  readonly _tag: "auth.user.signedIn";
  readonly userId: UserId;
  readonly strategy: string;
}
```

## Recommended fix

Introduce a shared event envelope (at: DateTime.Utc, correlationId) stamped at publish time — thread a request-scoped id via a Context.Reference so publish picks it up automatically; add opt-in ip/userAgent fields once the server exposes request context to domain code.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-006` — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook](medium/ARF-006-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ALF-002` — BEH-EA-098 violated: publish suspends when the 1024-slot buffer is full — the audit path can stall sign-in](high/ALF-002-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ALF-007` — on() subscriptions attach asynchronously — events published during startup are silently lost](medium/ALF-007-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`ALF-009` — PII rides the bus with no subscription access control or redaction](low/ALF-009-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, low)_`
- [`CWM-004` — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto](medium/CWM-004-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`CSG-004` — Audit stream is ephemeral in-memory PubSub with no durable sink or production subscriber](high/CSG-004-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-008` — Breach-detection signals are published but never consumed by any pipeline](medium/CSG-008-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`CSD-004` — No failed-authentication event is published — stuffing detection has no signal to subscribe to](medium/CSD-004-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- … 21 more findings touch `packages/core/src/AuthEvents.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-event-envelope`. Evidence at HEAD ec065a7: `packages/core/src/AuditLog.ts:45`. Fix: Introduce a request-scoped `AuthRequestContext` reference populated by the server layer and read by `publish`, and link subscriber handling to the originating span. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New core AuthRequestContext Reference (correlationId/ip/userAgent, all None by default); new @awthaq/server RequestContext.layer global HttpRouter middleware sets it per request (x-request-id if a sane token, else a W3C traceparent trace id, else a fresh uuidv7; ip via the ClientAddress port or the socket peer) and annotates logs; AuthEvents.publish reads it and captures the current span's trace/span ids; AuditLog persists correlationId in its column and ip/userAgent/trace ids in payload.meta; on()/onBatch handlers run under a root awthaq.event.handle span LINKED to the publishing span with correlationId annotated on logs (closes EOTS-009). Tests: AuthEvents.test.ts (context stamping, span ids), packages/server/test/RequestContext.test.ts (real Node server: x-request-id lands in both audit rows). The memory-server example composition gains RequestContext.layer with the EOTS-006 wiring.
