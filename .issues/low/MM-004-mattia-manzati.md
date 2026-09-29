---
ID: "MM-004"
Title: "Coverage is reported but never threshold-enforced, against the DoD's own gate 6"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "vitest.config.ts:17"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-004 — Coverage is reported but never threshold-enforced, against the DoD's own gate 6

`LOW` · `testing` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **ready-for-agent**

## Summary

`pnpm check` runs `coverage` as a gate, but the config defines provider/reporter/include only — no `thresholds`. spec/process/definitions-of-done.md gate 6 explicitly requires "with a coverage threshold enforced rather than merely reported", and the doc's own discipline says CI should run exactly the gate list so a second notion of done never grows up. Right now gate 6 is half-kept: coverage runs, nothing can fail it. The config's own comment reserves per-package thresholds for later, but the workspace-wide default is also unset.

## Evidence

Source: `vitest.config.ts:17`

```
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
```

## Recommended fix

Set workspace-wide `coverage.thresholds` (lines/functions at a modest floor) in vitest.config.ts, then add per-package overrides as packages earn stricter bars.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ETVS-007` — Coverage collected but never enforced, with a stale pointer to qadi's 'threshold pattern'](low/ETVS-007-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `coverage-enforcement`. Evidence at HEAD ec065a7: `vitest.config.ts:17`. Fix: Add workspace-wide coverage thresholds (floor just under the measured values) plus per-package overrides following ../qadi's pattern, and fix the ambiguous comment. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
