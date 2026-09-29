---
ID: "TTE-007"
Title: "Quality-metrics JSON is stale in both directions on type-safety KPIs"
Level: low
Category: "compliance"
Status: resolved
Package: "—"
Source: ".quality-metrics/core.json:8"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-007 — Quality-metrics JSON is stale in both directions on type-safety KPIs

`LOW` · `compliance` · `—` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

The per-package metrics report `typeAssertions: 0` and `brandedTypes: 0` for core (lines 7-9, 15), call "Zero type casts in src" a strength (line 179), and flag "five postfix `!`" at Auth.ts:230-269 (line 162) — but current code contains a real cast (Sessions.ts:228), four Brand.nominal types (Users.ts:25-26, Accounts.ts:27-28, Sessions.ts:28-29, Verification.ts:50-51), and `assertDefined` where the `!` used to be (Auth.ts:275-277). The extractor demonstrably misses casts-to-branded-types and predates the assertDefined refactor, so any dashboard built on these numbers understates violations and overstates non-null-assertion debt.

## Evidence

Source: `.quality-metrics/core.json:8`

```
"asAnyCasts": 0,
"typeAssertions": 0,
```

## Recommended fix

Regenerate `.quality-metrics` from the current tree and fix the extractor: count `as <Type>` excluding `as const`, recognize `Brand.nominal`/`Brand.Brand` patterns, and stop pattern-matching postfix `!` that no longer exists; consider adding `@ts-expect-error`-in-tests as a positive tracked KPI.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `quality-metrics-regeneration`. Duplicate of `DESS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `.quality-metrics/core.json:8`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
