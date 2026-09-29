---
ID: "FAMS-007"
Title: "Passwordless email-link sign-in absent; magic-link is an empty placeholder"
Level: info
Category: "architecture"
Status: resolved
Package: "magic-link"
Source: "packages/magic-link/src/index.ts:8"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-007 — Passwordless email-link sign-in absent; magic-link is an empty placeholder

`INFO` · `architecture` · `magic-link` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

Firebase's sendSignInLinkToEmail passwordless flow has no effect-auth equivalent: packages/magic-link exports nothing, the README marks every statement as intent, and the roadmap parks it in M7 Phase-2 (spec/roadmap.md:65-68, not active). What does exist is the hard part: core Verification issues single-use tokens hashed at rest with atomic SQL claim and auth.token.replay events on every failed consumption (packages/core/src/Verification.ts:11-31), and the password plugin already demonstrates the emailed-link encoding pattern (packages/password/src/Password.ts:177-192). The spec sketch (spec/models/04-magic-link.md:31-52) confirms it would reuse Verification with no new tables. Firebase email-link users will therefore need passwords set, or must wait for M7.

## Evidence

Source: `packages/magic-link/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

Implement MagicLink on the existing Verification substrate per its spec model; until then, document email-link users as requiring a set-password step in the migration runbook.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`IC-009` — Magic-link, api-key, two-factor plugins and CLI are empty placeholders](low/IC-009-iain-collins.md) `_(iain-collins, low)_`
- [`MLO-005` — packages/magic-link is an empty placeholder: no prefetch defense surface exists despite being the package's stated purpose](medium/MLO-005-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`SAM-009` — Passwordless and OTP migration targets do not exist yet (M7 placeholders)](info/SAM-009-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passwordless-magic-link-email-otp`. Duplicate of `BAM-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/magic-link/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
