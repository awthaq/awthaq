---
ID: "MM-005"
Title: "definitions-of-done ground-truth claims drifted: 'no pnpm check, no check.yml' is now false"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/process/definitions-of-done.md:95"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-005 — definitions-of-done ground-truth claims drifted: 'no pnpm check, no check.yml' is now false

`LOW` · `docs` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **ready-for-agent**

## Summary

The process doc (revision 1.2, Status: Effective) asserts there is no package.json, no lockfile, no workflow file, and no `pnpm check` — all four exist, and the check chain already implements gates 1/2/4/9/11 (typecheck, oxlint, madge, spec:verify:strict, package:smoke). The doc's stated purpose is that CI runs exactly this gate list so docs and reality never diverge; it now diverges from its own rule, which erodes the document's authority as the definition of done and hides which of the 14 gates are actually wired (9 commands vs 14 gates).

## Evidence

Source: `spec/process/definitions-of-done.md:95`

```
This table is not itself wired to anything: there is no `pnpm check`, no
`.github/workflows/check.yml`, and no script that verifies this table matches
a real command chain, because none of those exist to drift from yet. When CI
```

## Recommended fix

Add a gate→script mapping column to the table marking each gate as wired (name the exact `pnpm check` step), bump the revision, and consider a tiny spec:verify check that every 'Active' gate maps to a real script.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-roadmap-status-reconcile`. Evidence at HEAD ec065a7: `spec/process/definitions-of-done.md:95`. Fix: Add a 'Wired as' column mapping each of the 14 gates to the exact `pnpm check` step (or 'not wired'), flip Active? cells to the truth, and delete the 'nothing exists' prose; add a spec:verify check that every gate marked Active names a script present in package.json. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
