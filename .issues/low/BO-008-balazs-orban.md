---
ID: "BO-008"
Title: "Behavior spec claims pre-implementation while packages/next ships; BEH-EA-189 snippet contradicts the implemented contract"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/behaviors/24-nextjs-ssr.md:15"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-008 — Behavior spec claims pre-implementation while packages/next ships; BEH-EA-189 snippet contradicts the implemented contract

`LOW` · `docs` · `—` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **resolved**

## Summary

The banner is stale: packages/next implements BEH-EA-185/188/189 with tests. Worse, the spec's BEH-EA-189 example shows withNextCookies(Users.use((u) => u.rename(...))) — the domain-service-call form the implementation explicitly rejects as 'loose, superseded shorthand' (WithNextCookies.ts:24-28) — so the authoritative-looking doc teaches a call shape that silently writes nothing into the jar. Docs claiming intentions while code moved on is exactly the drift a spec-driven repo must not exhibit in its framework-facing story.

## Evidence

Source: `spec/behaviors/24-nextjs-ssr.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Refresh the banner per-document as code lands, and update BEH-EA-189's snippet to the real Response-to-jar contract (or annotate it as superseded with a pointer to the implementation decisions).

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`IC-006` — Behavior spec header still claims pre-implementation over shipped Next.js code](info/IC-006-iain-collins.md) `_(iain-collins, info)_`
- [`NAM-010` — Spec banner and BEH-EA-189 example contradict shipped code — migrators following the spec write non-compiling calls](medium/NAM-010-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `spec-behavior-code-reconcile`. Duplicate of `NAM-010` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/behaviors/24-nextjs-ssr.md:15`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
