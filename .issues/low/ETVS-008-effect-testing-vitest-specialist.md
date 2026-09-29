---
ID: "ETVS-008"
Title: "BDD↔unit layering exemplary where wired, but 21 of 27 feature files never execute"
Level: low
Category: "testing"
Status: resolved
Package: "—"
Source: "features/vitest.config.ts:7"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-008 — BDD↔unit layering exemplary where wired, but 21 of 27 feature files never execute

`LOW` · `testing` · `—` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **resolved**

## Summary

Only smoke, 07-sessions, 15-password, 16-oauth, 17-passkey and 27-admin-impersonation have steps.test.ts; the other 21 files (all of 03-http-layer, 04-cross-cutting, 06-roles-bridge, 07-client-integration, 08-tooling) contribute zero executable scenarios despite traceability.md presenting 602 REQ ids as one manifest. Where wiring exists the split is right: Worlds drive only the real HTTP surface (PasswordWorld.ts:6-8 discipline) while packages/*/test units own domain rules - no duplication of Gherkin scenarios as unit tests. But unwired files can silently promise behaviors that were never built: 25-testing-harness.feature contains REQ-EA-566's redaction-leak scenario that TestAuth.ts:29-33 itself admits is 'not mechanically verifiable today'.

## Evidence

Source: `features/vitest.config.ts:7`

```
// (.scratch/shipping-gaps), ticket 20 onward: step-definitions are now wired
// for a growing subset of features/features/00-* through 08-*: tracked
```

## Recommended fix

Keep shipping steps per the gap map, and until complete, make the gap visible in CI: a step that diffs the 602-id manifest against the set of scenarios reachable from wired steps files and reports the unwired count, so traceability.md readers can tell executed from aspirational scenarios.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-003` — Only 6 of 28 feature files are executable; ~15% of the specification runs](high/AH-003-aslak-hellesoy.md) `_(aslak-hellesoy, high)_`
- [`BDD-002` — 500 of 628 scenarios (80%) are never executed or reported — no step wiring, no pending placeholder](high/BDD-002-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bdd-feature-wiring`. Duplicate of `AH-003-aslak-hellesoy` — closed by that issue's fix. Evidence at HEAD ec065a7: `features/vitest.config.ts:20`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AH-003-aslak-hellesoy` — closed by its fix (see that issue's Resolved comment).
