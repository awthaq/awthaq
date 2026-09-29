---
ID: "AH-006"
Title: "Suite self-description is stale: README and STYLE claim pre-implementation with no runner"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "features/README.md:5"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-006 — Suite self-description is stale: README and STYLE claim pre-implementation with no runner

`MEDIUM` · `docs` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **ready-for-agent**

## Summary

README.md denies the existence of a package.json, Cucumber configuration, and step-definition layer — all three exist (features/package.json with @effect-cucumber/vitest ^0.10.1, features/vitest.config.ts, a 2,802-line step-definitions layer). STYLE.md line 9 makes the same false claim ('pre-implementation: no package, no source, no test runner') and mandates a banner asserting it at the top of every .feature file, so all 28 files open with a comment stating the harness that runs them does not exist. STYLE.md also instructs authors to leave scenarios untagged, yet 627 scenarios now carry allocated @REQ-EA tags. A new contributor reading the suite's own docs will misunderstand its entire operating model.

## Evidence

Source: `features/README.md:5`

```
**This suite is pre-implementation, same as the rest of the repository.** There is no `package.json`, no Cucumber configuration, and no step-definition layer wiring these scenarios to real code
```

## Recommended fix

Rewrite README/STYLE for the current state: describe the wired/unwired split, the @skip pruning policy, the allocated REQ tags, and retire the pre-implementation banner requirement (or scope it to the 21 still-unwired files).

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BDD-006` — README's pre-implementation claims contradict the wired suite it introduces](medium/BDD-006-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, medium)_`
- [`MTI-011` — No adversarial cross-tenant test suite; the BDD suite has no organization feature at all](low/MTI-011-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-suite-docs`. Evidence at HEAD ec065a7: `features/README.md:5`. Fix: Rewrite features/README.md and features/STYLE.md to the real operating model (wired/unwired split, @skip/@unwired conventions, allocator-owned REQ tags, run commands) and scope the pre-implementation banner to @unwired files only. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
