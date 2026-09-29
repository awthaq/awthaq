---
ID: "BDD-003"
Title: "features/traceability.md and spec/traceability.md §6 no longer describe the suite"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/traceability.md:213"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-003 — features/traceability.md and spec/traceability.md §6 no longer describe the suite

`MEDIUM` · `docs` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **ready-for-agent**

## Summary

spec/traceability.md §6 claims a contiguous 1:1 allocation across the suite and its file-level crosswalk table has no row for 27-admin-and-impersonation (grep finds '27-admin' only in the §1 rows at lines 13 and 53), while features/traceability.md states '602 REQ-EA ids allocated across 26 .feature files' against an actual suite of 627 tagged scenarios in 28 files. The manifest's per-scenario rows are internally consistent (602 unique ids) but the invariants its prose promises are false today, and the persona's red flag — traceability gone stale so artifacts exist with no mapping — is half-realized for the admin scenarios (BEH-EA-209..220 Rules exist with zero manifest rows).

## Evidence

Source: `spec/traceability.md:213`

```
`REQ-EA-001` through `REQ-EA-602` are allocated from it — one id per `Scenario:`/`Scenario Outline:`, tagged directly on the scenario
```

## Recommended fix

After resolving BDD-001, re-run the allocator, add the 27-admin crosswalk row to spec/traceability.md §6 with its REQ range, bump the manifest's Document Control revision/change-history instead of leaving the 2026-09-12 '1.0 initial release' header, and make regeneration part of the definition-of-done for new feature files.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `spec-bdd-traceability-refresh`. Already fixed by commit 6887fb5. Evidence at HEAD ec065a7: `spec/traceability.md:247`. Fix: The substantive drift (missing 27-admin row, 602 vs 627) was fixed by 6887fb5. Finish the job: bump the manifest's and spec/traceability.md's Document Control, fix every residual '602' range, and make manifest freshness a CI-checked property. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
