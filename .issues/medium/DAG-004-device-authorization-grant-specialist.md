---
ID: "DAG-004"
Title: "No user-code entropy/format or rate-limit design exists for the verification surface"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "spec/models/13-device-authorization.md:60"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-004 — No user-code entropy/format or rate-limit design exists for the verification surface

`MEDIUM` · `security` · `—` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **resolved**

## Summary

User-code brute-force resistance is the core security property of RFC 8628: an attacker who can guess a pending user code within its TTL can hijack the grant or spam approvals. MOD-EA-013 records this design as missing entirely. The better-auth corpus offers reference values (8-char crowd-readable charset ≈ 40 bits at a 31-symbol alphabet, 30-minute shared TTL, 5 requests per TTL on /device/code), but these are analysis of another framework, not decisions awthaq has made, and awthaq's Ports stratum RateLimiter (BEH-EA-105) — the natural primitive for the limit — has no device-flow consumer planned on paper.

## Evidence

Source: `spec/models/13-device-authorization.md:60`

```
no rate-limiting or user-code entropy design, and no research file in this repository treats device-code flow as its primary subject
```

## Recommended fix

Specify explicitly: crowd-readable alphabet excluding visually ambiguous characters, ≥8 chars, normalized typo-tolerant lookup on the verification endpoint (exact match first), RateLimiter consumption keyed per-IP and per-code on both /device/code and the approval endpoint with the window tied to the code TTL, and constant-time comparison for code lookup.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DAG-006` — Session-issuance integration point is well-prepared for a future device flow](info/DAG-006-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, info)_`
- [`DAG-007` — Zero test or BDD coverage allocated to the device domain](medium/DAG-007-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `device-authorization-design`. Evidence at HEAD ec065a7: `spec/models/13-device-authorization.md:60`. Fix: Now that decision 06 makes the device plugin the CLI's login backend, write its security parameters into the model doc (and later BEHs): user-code alphabet/length/entropy, TTL, normalization, constant-time lookup, RateLimiter rules on /device/code, /device/token and the approval endpoint. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/models/13-device-authorization.md rev 1.1: new 'Security parameters' section — user code 8 chars from the 20-symbol consonant alphabet BCDFGHJKLMNPQRSTVWXZ (~34.6 bits, RFC 8628 §6.1) shown XXXX-XXXX, normalized (uppercase, strip - and spaces) then exact match, stored SHA-256-hashed and looked up by hash; device_code 32 CSPRNG bytes hashed at rest; TTL 15 min (DeviceAuthorizationConfig Reference), interval 5s with slow_down +5s; RateLimiter rules: /device/code 5 per TTL per IP, verification/approval 5 failed lookups per 15 min per IP and per session, /device/token enforces interval per device_code; session issuance via Sessions.issue through Hooks.BeforeSessionIssue (ticket 03) with device ip/userAgent (BEH-EA-054). BEH ids deferred to when the plugin is specified as behaviors.
