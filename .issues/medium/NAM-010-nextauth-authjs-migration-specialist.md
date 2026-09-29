---
ID: "NAM-010"
Title: "Spec banner and BEH-EA-189 example contradict shipped code — migrators following the spec write non-compiling calls"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/24-nextjs-ssr.md:15"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-010 — Spec banner and BEH-EA-189 example contradict shipped code — migrators following the spec write non-compiling calls

`MEDIUM` · `docs` · `—` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **ready-for-agent**

## Summary

The Next.js SSR behavior spec still claims nothing is implemented, yet packages/next ships getSession/hasSessionCookie/withNextCookies — so a docs-led evaluator concludes the migration surface doesn't exist. Worse, the spec's own BEH-EA-189 example (line 99) shows `withNextCookies(Users.use((u) => u.rename(...)))` taking an Effect, while the shipped signature is `withNextCookies(response: Response, jar)` — WithNextCookies.ts:24-28 explicitly declares the cookbook snippet 'loose, superseded shorthand'. The spec banner drift also affects spec/overview.md. Docs are the first thing an ecosystem-migration specialist reads; here they actively mislead in both directions.

## Evidence

Source: `spec/behaviors/24-nextjs-ssr.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Regenerate the spec banners from package contents (implemented behaviors lose the pre-implementation banner) and update BEH-EA-189's example to the shipped (Response, CookieJarLike) signature.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-008` — Behavior spec claims pre-implementation while packages/next ships; BEH-EA-189 snippet contradicts the implemented contract](low/BO-008-balazs-orban.md) `_(balazs-orban, low)_`
- [`IC-006` — Behavior spec header still claims pre-implementation over shipped Next.js code](info/IC-006-iain-collins.md) `_(iain-collins, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-behavior-code-reconcile`. Evidence at HEAD ec065a7: `spec/behaviors/24-nextjs-ssr.md:15`. Fix: Code is ground truth here (implementation decisions recorded in .scratch/next-package/spec.md §'withNextCookies shape and scope'): rewrite 24-nextjs-ssr.md's status banner and the BEH-EA-185/189/190 code examples to the shipped signatures; keep the REQUIREMENT texts (the code satisfies them). (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
