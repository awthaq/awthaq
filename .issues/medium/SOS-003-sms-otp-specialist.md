---
ID: "SOS-003"
Title: "Mailer.send has no error channel, so channel delivery failure is untypeable — fatal for SMS where provider failure is routine"
Level: medium
Category: "api"
Status: resolved
Package: "ports"
Source: "packages/ports/src/Mailer.ts:38"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-003 — Mailer.send has no error channel, so channel delivery failure is untypeable — fatal for SMS where provider failure is routine

`MEDIUM` · `api` · `ports` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **resolved**

## Summary

The only implemented delivery port returns Effect.Effect<void> from send: there is no E in the channel, so an SMTP/API failure can only surface as a defect (layerNoop dies) or be swallowed. For email this is survivable; for SMS it is not — invalid destination, carrier rejection, provider outage, failover, and pumping-block responses are routine operational outcomes, not defects. The repo's own research already prescribes the correct shape: research/19-dbc-to-effect-mapping.md:183 requires 'a Notifier/Sms Context.Service invoked as the delivery callback, so delivery failure is a typed E, never a swallowed exception', and better-auth/GLOSSARY.md:193-196 names the send callback as 'a higher-order contract whose failure mode is distinct from the credential's own issuance/consumption contract'. An SmsSender cloned from Mailer as-is would inherit this gap.

## Evidence

Source: `packages/ports/src/Mailer.ts:38`

```
readonly send: (message: MailMessage) => Effect.Effect<void>;
```

## Recommended fix

Give SmsSender.send a typed error channel (e.g. Effect.Effect<void, SmsDeliveryError> with tagged causes: invalid-number, provider-rejected, quota-exceeded, temporarily-unavailable) and consider widening Mailer.send the same way. Plugins then decide retry/queue/degrade policy per error tag instead of dying.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EEM-002` — Mailer port types delivery as Effect<void> — an expected operational failure forced into the defect channel](high/EEM-002-effect-error-management-specialist.md) `_(effect-error-management-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `mailer-typed-delivery-errors`. Duplicate of `EEM-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/Mailer.ts:37`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `EEM-002-effect-error-management-specialist` — closed by its fix (see that issue's Resolved comment).
