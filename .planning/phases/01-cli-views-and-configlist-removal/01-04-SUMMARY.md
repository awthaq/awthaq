---
phase: 01-cli-views-and-configlist-removal
plan: 04
subsystem: cli
tags: [changeset, spec, traceability, gates, baseline]

requires:
  - phase: 01-02
    provides: "PluginViews.ts and PluginViews.test.ts"
  - phase: 01-03
    provides: "ConfigList module and export removed"
provides:
  - ".changeset/cli-plugin-views-config-list.md (@awthaq/cli minor, Migration line)"
  - "spec/behaviors/26-cli.md Revision 1.10 citing Cli.ts (config list) and PluginViews.ts"
  - "spec/traceability.md Revision 1.89 with a PluginViews.test.ts row"
  - "Phase-close gate comparison against 01-BASELINE.md"
affects: []

actuals:
  tokens: 2500
  tasks: 3
  commits: 2
plan_head_before: 090df686b5b59f65f53579cfe534b23c7d001383
plan_head_after: 1cd89efaeb35e067715746bb2b1eb37d5ef20f2d

tech-stack:
  added: []
  patterns:
    - "Spec Revision and Change History move in the same edit; the new row must not spell a removed module's name (tree-wide grep covers spec/)"

key-files:
  created:
    - .changeset/cli-plugin-views-config-list.md
  modified:
    - spec/behaviors/26-cli.md
    - spec/traceability.md

key-decisions:
  - "One changeset covers both the views module and the ConfigList export removal, bump level minor (test-app-removed precedent)"

requirements-completed: [GATE-01, GATE-03, CLI-03]

coverage:
  - id: D1
    description: "Changeset with a Migration line announces the removed ConfigList export; 26-cli.md cites what shipped; Revision and Change History bumped together"
    requirement: GATE-03
    verification:
      - kind: other
        ref: "grep -c '^Migration:' .changeset/cli-plugin-views-config-list.md => 1; grep -rn ConfigList spec packages docs examples features => 0; pnpm changeset status lists @awthaq/cli under minor"
        status: pass
      - kind: other
        ref: "pnpm spec:verify:strict PASS 32 FAIL 0 (after Task 1 and after Task 2)"
        status: pass
    human_judgment: false
  - id: D2
    description: "PluginViews.test.ts is traceable from spec/traceability.md (Revision 1.89)"
    requirement: GATE-03
    verification:
      - kind: other
        ref: "pnpm spec:verify:strict PASS 32 FAIL 0; grep -c packages/cli/test/PluginViews.test.ts spec/traceability.md => 1"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every baseline gate exits as at capture on the final tree"
    requirement: GATE-01
    verification:
      - kind: other
        ref: "Phase close vs baseline table below; all gates 0 except pnpm knip (1, pre-existing)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-14
status: complete
---

# Phase 1 Plan 4: Changeset, spec and phase-close gates Summary

One minor changeset with a `Migration:` line for the removed `ConfigList` export, `26-cli.md` (Revision 1.10) and `traceability.md` (Revision 1.89) updated with their Change History rows, and every baseline gate re-run green on the final tree.

## Accomplishments

- `.changeset/cli-plugin-views-config-list.md`: `"@awthaq/cli": minor`, prose naming BEH-EA-201/202/225/229, `Migration:` line pointing at `awthaq config list` or `EffectiveConfig.read(...)` through `Output.report`. It is the only changeset this phase adds.
- `spec/behaviors/26-cli.md`: BEH-EA-201 and BEH-EA-229 *Implementation* now cite `Cli.ts` (`config list`); BEH-EA-202 cites `PluginViews.ts` and `test/PluginViews.test.ts` and states the shipped precedence (dot, json, text; no DOT form for hooks, rules, events; failures follow only the global `--json`). Revision 1.10, Effective Date 2026-11-14, Change History row added.
- `spec/traceability.md`: `packages/cli/test/PluginViews.test.ts` row after the Inspection row; Revision 1.89 plus Change History row.
- `grep -rn ConfigList spec packages docs examples features` (excluding node_modules, lib) prints nothing.

## Phase close vs baseline

Final tree: HEAD `1cd89efa` (two task commits on top of `090df686`). `pnpm clean` then `npx tsc -b` ran first; `pnpm clean && pnpm build` ran before `package:smoke`. Wall times are whole seconds, one gate per call (machine load differs from capture).

| Gate | Baseline exit / summary / time | Close exit / summary / time | Verdict |
|------|-------------------------------|-----------------------------|---------|
| tsc -b (after pnpm clean) | 0 / no output / 5 s | 0 / no output / 11 s | match |
| tests typecheck | 0 / 0 `error TS` / 7 s | 0 / 0 `error TS` / 8 s | match |
| circular | 0 / 6 s | 0 / 3 s | match |
| error tags | 0 / 163 internal, 137 wire / <1 s | 0 / 163 internal, 137 wire / 1 s | match |
| transactions | 0 / 1 s | 0 / 1 s | match |
| lint | 0 / warnings only (87 `.claude/`, 7 RequestContextSteps) / 3 s | 0 / 87 `.claude/`, 7 RequestContextSteps, nothing else / 1 s | match |
| format:check | 0 / 1204 files / 1 s | 0 / 1205 files / 0 s | match (+1 file: the changeset) |
| readmes | 0 / 1 s | 0 / 1 s | match |
| workspace:check | 0 / 29 packages, 3 examples / 1 s | 0 / 29 packages, 3 examples / 1 s | match |
| test:bdd | 0 / 39 files, 1576 passed, 44 skipped / 16 s | 0 / 39 files, 1576 passed, 44 skipped / 11 s | match |
| pnpm test | 0 / 409 files passed, 4 skipped; 6390 passed, 1 expected fail, 15 skipped / 98 s | 0 / 410 files passed, 4 skipped; 6484 passed, 1 expected fail, 15 skipped / 111 s | match; +1 file, +94 tests, 0 lost |
| coverage | 0 / 91.61, 85.08, 86.8, 92.14 / 105 s | 0 / 91.65, 85.08, 86.9, 92.17 / 62 s | match; floors 89/83/84/90 all cleared |
| spec:verify:strict | 0 / PASS 32 FAIL 0 / 58 s | 0 / PASS 32 FAIL 0 / 78 s | match |
| package:smoke (after clean + build) | 0 / PASS for 30 packages / 81 s | 0 / PASS for 30 packages (cli included) / 52 s | match |
| knip | 1 (pre-existing) / 39 unused files all `.claude/`, 3 unlisted deps / 91 s | 1 (pre-existing) / same / 117 s | match |

Coverage percentages (statements / branches / functions / lines): 91.65 / 85.08 / 86.9 / 92.17 against floors 89 / 83 / 84 / 90.

Filtered knip (drop `^.claude/` and `^.reports/`): remainder is the `$ knip` banner, `Unused files (39)` and `Unlisted dependencies (3)` headings, the three `packages/sql/test/fixtures/readme-quickstart.ts` rows (`@awthaq/core` 2:10, `@awthaq/password` 11:10, `@awthaq/server` 12:10) and the `[ELIFECYCLE]` line. `readme-quickstart.ts` count 3 (>= 3); extra findings under packages/, examples/, features/, scripts/, spec/: 0. `git diff --stat a5ab6311 -- knip.json` is empty. `packages/cli/lib` has no `ConfigList*` output and contains `PluginViews.*`.

Not run locally: Postgres-gated tests (`AWTHAQ_POSTGRES_URL` unset); they are skipped inside the counts above.

## Task Commits

1. Task 1 (changeset, 26-cli.md 1.10): `ffe1e99f`
2. Task 2 (traceability.md 1.89): `1cd89efa`
3. Task 3 (gate run): no source change, recorded in this SUMMARY

## Deviations from Plan

None - plan executed exactly as written. One execution note: the 26-cli.md and traceability.md Document Control table lines are prefixed with `> `, so the Revision edit matched on that form.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- `.changeset/cli-plugin-views-config-list.md`, `spec/behaviors/26-cli.md`, `spec/traceability.md` exist and are committed (`ffe1e99f`, `1cd89efa` are ancestors of HEAD).
- `git status --short` shows only the orchestrator-owned untracked `.claude/` and `.planning/config.json|state.json` paths.
