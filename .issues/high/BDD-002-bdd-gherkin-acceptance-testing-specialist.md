---
ID: "BDD-002"
Title: "500 of 628 scenarios (80%) are never executed or reported — no step wiring, no pending placeholder"
Level: high
Category: "testing"
Status: resolved
Package: "—"
Source: "features/vitest.config.ts:19"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-002 — 500 of 628 scenarios (80%) are never executed or reported — no step wiring, no pending placeholder

`HIGH` · `testing` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

Only 6 .steps.test.ts files exist (smoke, 07-sessions, 15-password, 16-oauth, 17-passkey, 27-admin), loading 5 real feature files: 127 of 628 scenarios are step-bound and 94 execute after 33 @skips. The other 22 feature files (~500 scenarios) are never loaded by any test — vitest's include pattern only picks up *.steps.test.ts — so they neither pass, fail, nor appear as skipped/pending in any run. Undefined-step typos, stale phrasing, or spec drift in those files are invisible until someone wires them, which contradicts the suite's charter as 'the project's primary defense against behavior silently drifting from its written spec'. The config comment declares wiring 'a growing subset' with @skip-tagged tracking, but unwired files have no such in-run trace.

## Evidence

Source: `features/vitest.config.ts:19`

```
include: ["features/**/*.steps.test.ts"],
```

## Recommended fix

Generate a placeholder <feature>.steps.test.ts for every unwired file that calls describeFeature with an intentionally-empty step set behind a dedicated @unwired tag filter, so each scenario surfaces as pending/undefined in the vitest report; or add a CI dry-run that parses every .feature and fails on steps matching no registered pattern in the wired set.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-003` — Only 6 of 28 feature files are executable; ~15% of the specification runs](high/AH-003-aslak-hellesoy.md) `_(aslak-hellesoy, high)_`
- [`ETVS-008` — BDD↔unit layering exemplary where wired, but 21 of 27 feature files never execute](low/ETVS-008-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `features/vitest.config.ts:19` includes only `features/**/*.steps.test.ts`; exactly 6 such files exist (`_smoke/smoke.steps.test.ts` plus 5 feature-loading ones: `07-sessions`, `15-password`, `16-oauth`, `17-passkey`, `27-admin-impersonation`), which together wire 127 scenarios (24+24+27+27+25) out of 628 total `Scenario:`/`Scenario Outline:` occurrences across the 28 `.feature` files — matching the claimed ~500 (actually 501) unwired scenarios. Fix (placeholder `.steps.test.ts` generation or a CI dry-run parser) is mechanical/scriptable. Status → ready-for-agent.

**Resolved (2026-09-20):** Took the finding's first recommended option (placeholder generation), not the CI-dry-run-parser alternative — reusing `@effect-cucumber/vitest`'s own real step-matcher (via an actually-registered, empty-step `describeFeature` call) is strictly more accurate than hand-rolling a second Gherkin-step-matching implementation in a standalone script, and it means a scenario's exact fate (skipped / UndefinedStep / real pass-fail) is always decided by the one real code path, never approximated by a parallel one that could itself drift.

- Generated a matching `<feature>.steps.test.ts` next to each of the 22 previously-unwired `.feature` files (`00-foundations` through `08-tooling`, excluding the 6 already-wired ones this finding's own validation named). Each calls `describeFeature(feature, Layer.empty, () => {})` — zero steps registered — so `vitest`'s `features/**/*.steps.test.ts` include glob (already correct, per this finding's own evidence — the gap was files never existing under it, not the glob itself) now genuinely covers all 28 `.feature` files, not 6.
- Added a Feature-level `@skip @unwired` tag pair to each of those 22 `.feature` files (inherited by every child Scenario, `gherkinTags` auto-discovers it — no `vitest.config.ts` tag-list edit needed). `@skip` is the codebase's own existing, already-battle-tested mechanism (`Tags.ts`'s `isSkipped`) for "visible in the report, never runs its body, never fails the gate" — the exact three properties the finding's own recommended fix asked for ("surfaces as pending/undefined ... without failing"). `@unwired` is a second, purely-documentary tag with no runtime meaning of its own: a plain `grep -rl @unwired features/features` distinguishes "this Feature has literally never been wired" from an ordinary `@skip` on an otherwise-wired Feature (flaky/deliberately-disabled), which the pre-existing per-scenario `@skip` usage in `15-password.feature` etc. does not otherwise distinguish.
- `features/vitest.config.ts`'s own header comment updated to document the convention for the next person (or the next AH-003 wiring session) reading it.
- Found and fixed a **real, previously-undetected Gherkin syntax error** this exact fix was designed to catch: `features/features/00-foundations/03-ports-slots-hooks-registries.feature:168` read `And, among taps with no dependency relationship, ...` — a comma directly after the `And` keyword with no space, which the Gherkin tokenizer cannot match as a step keyword, so the *entire file* failed to parse. Because this file was never loaded by any test before this fix, the parse failure was invisible; the first real run under this fix's own placeholder file failed the whole suite with a `CompositeParserException`, which is exactly the class of previously-silent "spec drift" this finding's Summary predicted. Fixed by removing the stray comma (`And among taps ...`), preserving the scenario's intended meaning.

TDD/mutation-verified, not just asserted: (1) temporarily moved `01-plugin-contract.steps.test.ts` aside — confirmed the suite's total test-file/test count dropped back by exactly that file's own 17 scenarios (28→27 files, 695→678 tests), proving the placeholder file is what makes them visible; restored it. (2) temporarily changed that same file's Feature tag from `@skip @unwired` to `@unwired` alone — confirmed all 17 of its scenarios then genuinely FAILED with `UndefinedStep` (19 total failures = 2 pre-existing unrelated + these 17), proving `@skip` (not `@unwired`, which carries no runtime behavior) is what keeps an unwired Feature from failing the gate; restored the tag pair and confirmed the suite returned to its baseline (102 passed, 2 pre-existing unrelated failures, 591 skipped, 695 total, 28/28 files loading).

Full monorepo `pnpm run typecheck` clean. `pnpm run test` unaffected (744 passed, same as before this fix — this finding never touched anything outside `features/`). `pnpm run test:bdd`: every one of the 628 `Scenario:`/`Scenario Outline:` occurrences (695 actual test instances once Outline Examples rows are counted individually) across all 28 `.feature` files is now a real, individually reported vitest node — 102 passed, 2 failed (the same pre-existing, unrelated `15-password.steps.test.ts` reset-mail-ordering failures documented in BCR-003's own resolution, untouched by this change), 591 skipped (the 500 newly-`@unwired` scenarios plus the pre-existing per-scenario `@skip`s already inside the 6 wired files) — zero scenarios remain absent from the report. `npx oxfmt` run on the 22 new `.steps.test.ts` files and `vitest.config.ts`; re-verified typecheck/BDD green after formatting.

Deliberately NOT done here (belongs to AH-003's own already-deferred, risk-tiered wiring effort, `.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md`): writing real step definitions for any of the 22 files, auditing whether each file's "pre-implementation" header banner is still accurate now that some of the underlying systems (sessions, hooks, events) have since shipped, and adding a wiring-status column to `features/traceability.md` (AH-003's own recommended fix, not this finding's).
