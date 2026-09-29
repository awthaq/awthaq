---
ID: "IC-009"
Title: "Magic-link, api-key, two-factor plugins and CLI are empty placeholders"
Level: low
Category: "dx"
Status: resolved
Package: "magic-link"
Source: "packages/magic-link/src/index.ts:8"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-009 — Magic-link, api-key, two-factor plugins and CLI are empty placeholders

`LOW` · `dx` · `magic-link` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

The email/magic-link provider is one of the most-deployed pieces of the NextAuth surface (it is how thousands of apps ship passwordless), and a CLI scaffolding auth into an app is the front door of the modern DX. All are export-{} stubs pending M7-era work (packages/cli/src/index.ts:8, packages/api-key and packages/two-factor likewise), so the achievable provider surface today is password + OAuth + passkey only. Honest placeholders, but the advertised plugin table in the root README lists packages that currently add nothing.

## Evidence

Source: `packages/magic-link/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
//
export {};
```

## Recommended fix

Annotate the root README plugin table with per-package implementation status so users do not compose against placeholder imports, and sequence magic-link ahead of the remaining M7 plugins given its prevalence.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`FAMS-007` — Passwordless email-link sign-in absent; magic-link is an empty placeholder](info/FAMS-007-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, info)_`
- [`MLO-005` — packages/magic-link is an empty placeholder: no prefetch defense surface exists despite being the package's stated purpose](medium/MLO-005-magic-link-email-otp-specialist.md) `_(magic-link-email-otp-specialist, medium)_`
- [`SAM-009` — Passwordless and OTP migration targets do not exist yet (M7 placeholders)](info/SAM-009-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passwordless-magic-link-email-otp`. Duplicate of `BAM-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/magic-link/src/index.ts:8`. Full dossier: `.plan/slices/07-password-mfa.md`. Status → resolved.
