---
ID: "BDD-004"
Title: "STYLE.md's central premise and prohibitions are falsified by current practice"
Level: medium
Category: "docs"
Status: resolved
Package: "—"
Source: "features/STYLE.md:9"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-004 — STYLE.md's central premise and prohibitions are falsified by current practice

`MEDIUM` · `docs` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

STYLE.md mandates the 'system that does not exist yet' banner on every file and forbids scenario REQ tags ('Don't tag scenarios with @REQ-EA-*', line 237), but the suite now has a package.json, vitest config, 12 step-definition files, 627 @REQ-EA-tagged scenarios, and a newest file (27-admin) whose header states it was 'authored against the real, already-implemented @awthaq/admin plugin' and deliberately omits the banner. The style contract was never revised after the allocation pass and the implementation landed, so authors following it today would produce non-conforming files — the one-author-one-voice goal STYLE.md exists for is eroding from the doc side, not the file side.

## Evidence

Source: `features/STYLE.md:9`

```
`awthaq` is pre-implementation: no package, no source, no test runner.
```

## Recommended fix

Revise STYLE.md to describe the current lifecycle: banner required only for authored-ahead-of-code files, REQ tagging now mandatory via the allocator (keep hand-tagging forbidden), @skip/@only conventions and the shipping-gap rationale comments documented, and the compile-time section updated to note BEH-EA-193..200's harness partially exists.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bdd-suite-docs`. Duplicate of `AH-006-aslak-hellesoy` — closed by that issue's fix. Evidence at HEAD ec065a7: `features/STYLE.md:9`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
