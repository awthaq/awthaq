---
ID: "EOTS-005"
Title: "The only two log sites serialize raw Cause payloads with no redaction pass"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:293"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-005 — The only two log sites serialize raw Cause payloads with no redaction pass

`MEDIUM` · `correctness` · `core` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **resolved**

## Summary

Both log call sites in the library (`AuthEvents.ts:294` and `HookPoint.ts:258`) log the entire captured `Cause` of a subscriber/tap failure. A failing observer's defect payload is printed verbatim — there is no redaction interceptor (EOTS-002) to catch a case where a plugin's handler error embeds credential material (e.g. a Mailer implementation error carrying `MailMessage.data`, which includes verification tokens, per EOTS-010). The stable event names and `tag`/`hook` context fields are exactly right per BEH-EA-104/REQ-EA-277; the unredacted payload channel is the gap.

## Evidence

Source: `packages/core/src/AuthEvents.ts:293`

```
Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
```

## Recommended fix

Log a sanitized summary (tag, error `_tag`/message) and attach the full cause only at debug level, or route causes through the BEH-EA-199 interceptor's redactor once it exists.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `observability-substrate`. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:405`. Fix: Log a sanitized summary at error level and the full cause only at debug level, via one shared helper. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New Observability.logObserverFailure: error level carries only errorTag + truncated message (never the error's data fields); the full Cause is logged only at debug. Used by AuthEvents.on/onBatch (auth.event.observer.error, counted in awthaq_event_observer_error_total{tag}), the subscription supervisor and HookPoint.observe. Tests: AuthEvents.test.ts (error record has SinkError but not the token; debug record has the cause; metric counted).
