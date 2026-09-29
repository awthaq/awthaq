---
ID: "MM-003"
Title: "@effect/tsgo pinned exact but typescript caret — patched pair can drift"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "package.json:36"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-003 — @effect/tsgo pinned exact but typescript caret — patched pair can drift

`LOW` · `dx` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **ready-for-agent**

## Summary

`prepare: effect-tsgo patch` rewires the installed `typescript` package so plain `tsc` runs the Effect-aware native compiler; the patch is version-coupled to the compiler it patches. tsgo is pinned exact (0.45.0) while the catalog allows `typescript: ^7.0.0` (currently 7.0.2), so a typescript-only bump re-applies a 0.45.0 patch to a newer compiler with no guard — exactly the silent-skew class this repo elsewhere makes loud (effect pinned exact rc, `duplicatePackage: error`). The lockfile pins 7.0.2 today, so the risk materializes on the next 'update typescript' changeset.

## Evidence

Source: `package.json:36`

```
"@effect/tsgo": "0.45.0",
```

## Recommended fix

Pin `typescript` exact in the catalog (7.0.2) and bump it in lockstep with @effect/tsgo, or add a cheap consistency check (version-pair table in the repo, asserted in package-smoke) so the pair cannot drift silently.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MM-010` — format/format:check hand-duplicate their explicit target lists (drift already visible)](low/MM-010-mattia-manzati.md) `_(mattia-manzati, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `dev-scripts-tooling`. Evidence at HEAD ec065a7: `package.json:36`. Fix: Pin typescript exactly and make the pair move together. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
