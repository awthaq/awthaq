---
ID: "SOS-007"
Title: "Rate-limit key strategies have no recipient/E.164 notion; SMS pumping protection would lean entirely on the warned-about escape hatch"
Level: low
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/RateLimits.ts:57"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-007 — Rate-limit key strategies have no recipient/E.164 notion; SMS pumping protection would lean entirely on the warned-about escape hatch

`LOW` · `security` · `core` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **resolved**

## Summary

The built-in bucket keys are principal and ip; anything else (including the phone number an SMS send endpoint bills against) falls to the function escape hatch, whose own doc comment (line 56) warns it is for authors who have 'already reasoned through the risk a fixed string key would otherwise carry (a caller-chosen value collectively locking out a NATed office, or an attacker-controlled bucket)'. A destination phone number is precisely a caller-chosen value — an attacker picks the numbers to pump — so toll-fraud defense needs simultaneous per-destination, per-principal, and per-IP caps, each a separate rule. The good news: the registry supports multiple rules per endpoint and the password plugin already demonstrates the per-recipient pattern (resendVerification keyed by lowercased email at packages/password/src/Password.ts:595, 3 per 15 min, justified as an inbox-flooding harassment vector against the target at lines 162-165).

## Evidence

Source: `packages/core/src/RateLimits.ts:57`

```
export type RateLimitKey = "principal" | "ip" | ((input: unknown) => string);
```

## Recommended fix

When the SMS plugin lands, ship it with a mandatory rule pair from day one: per-recipient-E.164 cap (the password resend pattern, normalized) plus per-IP cap on the send endpoint, both registered through AuthRateLimits.rule like password does at Password.ts:427-438 — and document in the plugin README that removing them is the toll-fraud red flag this persona screens for.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `verification-otp-substrate`. Evidence at HEAD ec065a7: `packages/core/src/RateLimits.ts:57`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.

**Resolved (2026-09-29):** Added `RateLimits.phoneKey(read, options?)` in core: a `RateLimitKey` function strategy whose bucket is `phone:<E.164>` after `Phone.normalizePhone` (spellings of one number share a budget; non-phone input goes to one shared `phone:invalid` bucket, never unthrottled), so an SMS-sending endpoint registers a per-recipient rule beside `"ip"` and `"principal"` rules (the toll-fraud defence is those simultaneous caps; documented on the function). Tests: RateLimitKeys.test.ts 'RateLimits.phoneKey (SOS-007)' incl. enforcement through `enforceRule`. The mandatory rule pair itself belongs to the future SMS plugin.
