---
ID: "MLO-005"
Title: "packages/magic-link is an empty placeholder: no prefetch defense surface exists despite being the package's stated purpose"
Level: medium
Category: "security"
Status: resolved
Package: "magic-link"
Source: "packages/magic-link/src/index.ts:10"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-005 — packages/magic-link is an empty placeholder: no prefetch defense surface exists despite being the package's stated purpose

`MEDIUM` · `security` · `magic-link` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

The passwordless plugin advertises 'Passwordless sign-in via a single-use emailed link' yet exports nothing (9 LOC, no spec/behaviors file, roadmap M7). Nothing in the repo implements the persona's core mitigations: confirmation-click interstitials, POST-only consumption of mailed links, user-agent prefetch heuristics, or an OTP alternative. The shipped password plugin hands consumers a raw `<identifier>.<secret>` token string (Password.ts:177), so each application invents its own delivery URL - including GET links with the token in the query string, which corporate scanners (Defender, Proofpoint) prefetch and silently burn, the exact red-flag failure mode this package exists to prevent.

## Evidence

Source: `packages/magic-link/src/index.ts:10`

```
export {};
```

## Recommended fix

When M7 lands, ship an opinionated link builder plus a POST-form (or confirmation-click) consumption route and an EmailOtp fallback, so consumers cannot accidentally mint prefetch-vulnerable GET links; keep the placeholder's honest `export {}` until then.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Passwordless Email Tokens
- Full dossier: [`magic-link-email-otp-specialist`](../../.reports/magic-link-email-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`FAMS-007` — Passwordless email-link sign-in absent; magic-link is an empty placeholder](info/FAMS-007-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, info)_`
- [`IC-009` — Magic-link, api-key, two-factor plugins and CLI are empty placeholders](low/IC-009-iain-collins.md) `_(iain-collins, low)_`
- [`SAM-009` — Passwordless and OTP migration targets do not exist yet (M7 placeholders)](info/SAM-009-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passwordless-magic-link-email-otp`. Duplicate of `BAM-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/magic-link/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
