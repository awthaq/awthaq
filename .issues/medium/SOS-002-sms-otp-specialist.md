---
ID: "SOS-002"
Title: "No SmsSender port: the archive design reserved auth.sms but the ports stratum never implemented it"
Level: medium
Category: "architecture"
Status: needs-triage
Package: "ports"
Source: "packages/ports/src/index.ts:27"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-002 — No SmsSender port: the archive design reserved auth.sms but the ports stratum never implemented it

`MEDIUM` · `architecture` · `ports` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **needs-triage**

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
