---
ID: "CSD-004"
Title: "No failed-authentication event is published — stuffing detection has no signal to subscribe to"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthEvents.ts:12"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-004 — No failed-authentication event is published — stuffing detection has no signal to subscribe to

`MEDIUM` · `security` · `core` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

The event registry's real publishers are auth.user.created, auth.user.signedIn (Password.ts:495, 560) and auth.token.replay. signIn's failure path (Password.ts:539) fails with Api.InvalidCredentials and publishes nothing. A subscriber-based defense — the natural extension point in this architecture — cannot count failed attempts, detect velocity spikes, alert on a targeted account, or trigger lockout/step-up, because failures are invisible outside the request. Detection is the 'D' in stuffing defense and it is structurally absent.

## Evidence

Source: `packages/core/src/AuthEvents.ts:12`

```
* `auth.token.replay`, `@awthaq/password`'s `auth.user.created`/
* `auth.user.signedIn`) is that same growth, not a narrowing of the design.
```

## Recommended fix

Publish a typed auth.signin.failed event (userId when resolvable, strategy, and a salted hash of the attempted email rather than the raw value) from the signIn failure path; the AuthEvents pubsub and BEH-EA-101 registry already support adding tags as publishers appear.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `auth-event-taxonomy`. Already fixed by commit f5eb570. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:56`. Fix: Enrich the failure event with `ip` and a keyed, non-reversible `identifierDigest`, and publish it from every strategy's failure path. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** auth.user.signInFailed gains clientIp and identifierDigest (HMAC-SHA256 over the normalized attempted identifier keyed by PasswordConfig.identifierDigestKey, default a per-process random key; computed identically for real and nonexistent accounts) and reasons assertionInvalid/callbackRejected; published by Password (both failure paths), Passkey.authenticateVerify (wrapper over the ceremony) and OAuth.callback (wrapper over the flow, only OAuthCallbackFailed). Deviation: the source-address field is named clientIp because the envelope already owns ip (the request context). Tests: Password.test.ts (digest stable per identifier, normalized, distinct across identifiers, no email/userId), passkey and oauth failure-event tests.
