---
ID: "BDD-006"
Title: "README's pre-implementation claims contradict the wired suite it introduces"
Level: medium
Category: "docs"
Status: resolved
Package: "—"
Source: "features/README.md:5"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-006 — README's pre-implementation claims contradict the wired suite it introduces

`MEDIUM` · `docs` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

The README asserts the suite is unwired, but features/package.json (workspace deps on @awthaq/password, @awthaq/oauth, @effect-cucumber/vitest...), features/vitest.config.ts, 12 step-definition files, and 6 steps.test.ts entry points all exist and execute 94 scenarios. Its mapping table also says '26 total' files across 9 directories with BEH-EA 001-208, while the tree now holds 28 files (plus smoke) across 10 directories including 09-admin-and-impersonation (BEH-EA 209-220). A newcomer calibrating trust from the README will misjudge what actually runs.

## Evidence

Source: `features/README.md:5`

```
There is no `package.json`, no Cucumber configuration, and no step-definition layer wiring these scenarios to real code
```

## Recommended fix

Update the README: replace the pre-implementation paragraph with the actual run story (pnpm test in features/, wired subset listed, @skip policy), extend the directory table with 09-admin-and-impersonation and the BEH-EA 209-220 range, and link the shipping-gap tracking.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-006` — Suite self-description is stale: README and STYLE claim pre-implementation with no runner](medium/AH-006-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`MTI-011` — No adversarial cross-tenant test suite; the BDD suite has no organization feature at all](low/MTI-011-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bdd-suite-docs`. Duplicate of `AH-006-aslak-hellesoy` — closed by that issue's fix. Evidence at HEAD ec065a7: `features/README.md:5`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
