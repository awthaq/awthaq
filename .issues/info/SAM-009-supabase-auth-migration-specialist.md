---
ID: "SAM-009"
Title: "Passwordless and OTP migration targets do not exist yet (M7 placeholders)"
Level: info
Category: "architecture"
Status: resolved
Package: "magic-link"
Source: "packages/magic-link/src/index.ts:8"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-009 — Passwordless and OTP migration targets do not exist yet (M7 placeholders)

`INFO` · `architecture` · `magic-link` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **resolved**

## Summary

Supabase workloads lean heavily on magic links, email OTP, and SMS OTP. effect-auth's magic-link and two-factor packages are honest export-{} placeholders (two-factor likewise at packages/two-factor/src/index.ts:8), with roadmap M7 listing TwoFactor, MagicLink, and EmailOtp as unbuilt (spec/roadmap.md:65-68). A GoTrue app using these flows has no functional target until M7 lands; those user populations either migrate to password/passkey/OAuth flows or wait. This is honestly disclosed rather than fake-implemented, which is the right call — but migration planners must know the passwordless door is not open yet.

## Evidence

Source: `packages/magic-link/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

Sequence a Supabase migration behind M7's MagicLink/EmailOtp plugins if the source workload uses OTP flows, or plan a deliberate funnel shift to the already-shipped passkey and password flows for those users during the migration window.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`FAMS-007` — Passwordless email-link sign-in absent; magic-link is an empty placeholder](info/FAMS-007-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, info)_`
- [`IC-009` — Magic-link, api-key, two-factor plugins and CLI are empty placeholders](low/IC-009-iain-collins.md) `_(iain-collins, low)_`
- [`MLO-005` — packages/magic-link is an empty placeholder: no prefetch defense surface exists despite being the package's stated purpose](medium/MLO-005-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passwordless-magic-link-email-otp`. Duplicate of `SOS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/magic-link/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `SOS-001-sms-otp-specialist` — closed by its fix (see that issue's Resolved comment).
