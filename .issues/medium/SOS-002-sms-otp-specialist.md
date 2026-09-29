---
ID: "SOS-002"
Title: "No SmsSender port: the archive design reserved auth.sms but the ports stratum never implemented it"
Level: medium
Category: "architecture"
Status: resolved
Package: "ports"
Source: "packages/ports/src/index.ts:27"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-002 — No SmsSender port: the archive design reserved auth.sms but the ports stratum never implemented it

`MEDIUM` · `architecture` · `ports` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **resolved**

## Summary

The implemented ports stratum exports seven ports (Encryption, KeyProvider, Mailer, PasswordHasher, RateLimiter, SqlTransaction, WebAuthn) — no SMS capability. Meanwhile archive/design/api-design.md:584 reserved the seam explicitly: 'sms: Capability.exclusive("auth.sms", SmsSender)' sits right between mailer and rateLimiter in the design-time Capabilities registry, and research/05-oauth-oidc.md:142 repeats it ('SMS: same capability shape, Sms tag, phase 2'). The seam was designed and then dropped on the floor: neither the port, nor the Capabilities registry itself, nor any provider layer exists, so a future plugin author has no capability-over-vendor boundary and would be pushed toward hard-coding a provider SDK.

## Evidence

Source: `packages/ports/src/index.ts:27`

```
export * as Encryption from "./Encryption.ts";
export * as KeyProvider from "./KeyProvider.ts";
export * as Mailer from "./Mailer.ts";
```

## Recommended fix

Add ports/src/SmsSender.ts mirroring Mailer's structure: an SmsMessage shape carrying a normalized E.164 destination plus a template/purpose tag, send + sent (recorded, for tests), a layerNoop that dies loudly in prod like Mailer.layerNoop (packages/ports/src/Mailer.ts:50-62), and a layerMemory for test assertions. Export it from the ports index so plugin authors require the capability, never a vendor.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `mailer-typed-delivery-errors`. Evidence at HEAD ec065a7: `packages/ports/src/index.ts:27`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/09-ports-apikey-cli.md`.

**Resolved (2026-09-29):** Added `SmsSender` to @awthaq/ports (src/SmsSender.ts, exported from index): `SmsMessage { to (normalised E.164), template, data? }`, `send`/`sent`/`development`, layers `layerNoop` (dies loudly, defect names the template only, EOTS-010), `layerMemory`, `layerConsole` (dev only, logs the code), and a typed `SmsDeliveryFailed { template, reason, retryable, cause? }` mirroring `Mailer`'s `MailDeliveryFailed`. Tests: packages/ports/test/SmsSender.test.ts. spec/overview.md ports inventory and table, ports README. No provider or plugin ships (ADR-EA-021's SMS plugin remains its own work); ports sits below core so the destination is typed as a string that core's `Phone.normalizePhone` produces (`Users.findByPhone`/promoteIdentity already take the branded `E164`); no plugin consumes both yet, so nothing more is wired. Deferred: an `sms-development` finding in `awthaq doctor --build` (CLI is another agent's area this round).
