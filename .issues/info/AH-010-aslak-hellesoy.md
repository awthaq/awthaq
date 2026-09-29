---
ID: "AH-010"
Title: "Traceability manifest stale: 602/26 documented vs 627 tags in 27 spec files"
Level: info
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "features/traceability.md:17"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-010 — Traceability manifest stale: 602/26 documented vs 627 tags in 27 spec files

`INFO` · `docs` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **ready-for-agent**

## Summary

The generated manifest documents 602 ids across 26 files, but the suite now carries 627 @REQ-EA tags across 27 specification feature files (28 including _smoke): the 25 unaccounted tags are precisely the duplicated admin ids from AH-001, and the manifest's maximum id is REQ-EA-602 (26-cli.feature) while admin scenarios use 382–406. The manifest header also claims to be the complete 'one row per REQ-EA-NNN scenario id' record; today a reader has no way to discover the admin scenarios from it. This is drift, not design — the allocator explicitly says to re-run after adding scenarios.

## Evidence

Source: `features/traceability.md:17`

```
602 `REQ-EA-NNN` ids allocated across 26 `.feature` files.
```

## Recommended fix

Same fix as AH-001 (re-run allocator, regenerate), plus a cheap CI assertion that (a) every @REQ-EA tag in features/ appears exactly once in traceability.md and (b) tag count equals manifest row count, so the manifest can never silently rot again.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-006` — Organization plugin has no BDD feature file — the deepest plugin's lifecycle contract is specified only by unit tests and code](low/CWM-006-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `bdd-suite-docs`. Already fixed by commit 6887fb5. Evidence at HEAD ec065a7: `features/traceability.md:17`. Fix: Harden spec/scripts/verify-traceability.sh check 4 into a bijection check between @REQ-EA tags in features/features and rows of features/traceability.md, and refresh its stale 602 comments. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
