---
ID: "IC-006"
Title: "Behavior spec header still claims pre-implementation over shipped Next.js code"
Level: info
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/behaviors/24-nextjs-ssr.md:15"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-006 — Behavior spec header still claims pre-implementation over shipped Next.js code

`INFO` · `docs` · `—` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

BEH-EA-185/188/189 in this file are implemented and tested in packages/next (getSession, hasSessionCookie, withNextCookies with their own test files), yet the document banner tells a reader no code exists. Cross-checking docs against code is this repo's stated discipline; stale banners are exactly the kind of claim that erodes trust in the spec layer for the next auditor or contributor.

## Evidence

Source: `spec/behaviors/24-nextjs-ssr.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Sweep the spec banner convention: once a BEH has an implementing package, replace the pre-implementation banner with pointers to the implementing module and tests (the repo already cross-references in the opposite direction).

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-008` — Behavior spec claims pre-implementation while packages/next ships; BEH-EA-189 snippet contradicts the implemented contract](low/BO-008-balazs-orban.md) `_(balazs-orban, low)_`
- [`NAM-010` — Spec banner and BEH-EA-189 example contradict shipped code — migrators following the spec write non-compiling calls](medium/NAM-010-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `spec-behavior-code-reconcile`. Duplicate of `NAM-010` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/behaviors/24-nextjs-ssr.md:15`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `NAM-010-nextauth-authjs-migration-specialist` — closed by its fix (see that issue's Resolved comment).
