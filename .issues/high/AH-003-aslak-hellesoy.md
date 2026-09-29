---
ID: "AH-003"
Title: "Only 6 of 28 feature files are executable; ~15% of the specification runs"
Level: high
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "features/vitest.config.ts:19"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-003 — Only 6 of 28 feature files are executable; ~15% of the specification runs

`HIGH` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **ready-for-agent**

## Summary

vitest discovers only *.steps.test.ts files, and just 6 exist (smoke, sessions, password, oauth, passkey, admin) covering 127 of 627 scenarios, of which 34 are @skip'd — roughly 93 scenarios (15%) actually execute. The 21 unwired feature files (00-foundations, 01-contract, most of 02/03/04/06/07/08) are pure prose: no step-match check ever runs against them, so typos, vocabulary drift, or broken step text accumulate silently, and the acceptance suite as a whole cannot fail. The config comment itself concedes wiring is 'a growing subset', but nothing tracks or gates the gap per file.

## Evidence

Source: `features/vitest.config.ts:19`

```
include: ["features/**/*.steps.test.ts"],
```

## Recommended fix

Track wiring status per feature file (a column in traceability.md is the natural home), and prioritize by risk: sessions/CSRF/http-error-mapping before client-integration. Even a minimal wiring pass that executes the happy-path scenario per unwired Rule converts dead prose into failing-capable specifications.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BDD-002` — 500 of 628 scenarios (80%) are never executed or reported — no step wiring, no pending placeholder](high/BDD-002-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, high)_`
- [`ETVS-008` — BDD↔unit layering exemplary where wired, but 21 of 27 feature files never execute](low/ETVS-008-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `features/vitest.config.ts:19` includes only `features/**/*.steps.test.ts`, exactly as quoted, and there are 28 `.feature` files against only 6 `.steps.test.ts` files (smoke, sessions, password, oauth, passkey, admin), matching the claimed ~6-of-28 wiring ratio. Closing this gap is a large, judgment-heavy prioritization effort across 21 unwired files (the recommended fix itself calls for risk-based sequencing), not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [BDD feature-file wiring prioritization](../../.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md) — a 5-tier risk-based priority order (auth-middleware/CSRF/error-mapping/verification-tokens/users-accounts first, client/tooling last) with a tiered minimal-wiring-depth policy (happy-path + one failure-mode scenario per Rule for Tier 1-2, happy-path-only for Tiers 3-5). Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-feature-wiring`. Evidence at HEAD ec065a7: `features/vitest.config.ts:32`. Fix: Execute decision 36 (.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md): wire real step definitions into the 22 @skip @unwired feature files in its 5-tier risk order with the tiered depth policy, and add a per-file wiring-status table to spec/traceability.md §6. (effort XL). Full dossier: `.plan/slices/13-repo-features-tooling.md`.
