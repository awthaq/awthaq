---
phase: 01-cli-views-and-configlist-removal
plan: 01
subsystem: testing
tags: [cli, vitest, effect, output-matrix, gate-baseline, knip]

requires: []
provides:
  - "01-BASELINE.md: measured exit code, summary line and wall time for all 15 gates on the untouched tree, raw knip output, working-tree state, phase-close comparison rule"
  - "PluginViews.test.ts: mode x view x fixture matrix (5 views x 6 modes x 2 fixtures), literal text pins, selector precedence, real-argv and failure-rendering pins, 88 cases green against untouched Plugin.ts"
  - "openapi text vs --json stdout parity pin, migration apply text/--json stdout pins, config list byte pin (text and --json) through runCli"
affects: [01-02, 01-03, 01-04]

actuals:
  tokens: 6900
  tasks: 3
  commits: 4
plan_head_before: 65f9a73aebc018451e5e99467a1456353699fa5f
plan_head_after: 4f4a5b8e31831d74f39ff3f0263da774f1e4ce70

tech-stack:
  added: []
  patterns:
    - "View x mode matrix: one generated it.effect per cell over Output.capture, asserting whole stdout/stderr/documents arrays"
    - "Renderer-derived expectations (renderEvents/renderRules of the builder) paired with a literal head and line count, so a new core event does not break the pin but a renderer swap does"

key-files:
  created:
    - .planning/phases/01-cli-views-and-configlist-removal/01-BASELINE.md
    - packages/cli/test/PluginViews.test.ts
  modified:
    - packages/cli/test/Inspection.test.ts
    - packages/cli/test/Migration.test.ts
    - packages/cli/test/Doctor.test.ts

key-decisions:
  - "The matrix encodes the resolution contract in the test (dot only where a view has a dot branch, then json if --format json or --json, else text) and asserts documents/stdout/stderr per cell, so it runs unchanged after the views module lands"
  - "Failure-rendering pin: runCli with no config exits 9; `--format json` alone gives one `awthaq: no configuration module in this test` stderr line, global `--json` gives one JSON failure document"
  - "Doctor config list pin builds its expectation from EffectiveConfig.read(Doctor.configContext, Doctor.descriptorsOf), imports nothing that plan 01-03 deletes, and leaves the ECS-005 canary case untouched"

patterns-established:
  - "Baseline before code: 01-BASELINE.md is the first commit of the phase, ahead of every test and source commit"

requirements-completed: [GATE-02, CLI-02]

coverage:
  - id: D1
    description: "Gate baseline recorded before any packages/cli/src change (raw knip output, git status, knip.json diff, per-gate exit/summary/time, comparison rule)"
    requirement: GATE-02
    verification:
      - kind: other
        ref: "test -f 01-BASELINE.md; grep -c readme-quickstart.ts => 4; grep -cF 'Phase-close comparison rule' => 1; git merge-base --is-ancestor 96c29821 6dc0658f"
        status: pass
    human_judgment: false
  - id: D2
    description: "Mode x view matrix, selector precedence, real-argv and failure-rendering pins green against untouched Plugin.ts"
    requirement: CLI-02
    verification:
      - kind: unit
        ref: "packages/cli/test/PluginViews.test.ts (88 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "openapi, migration apply and config list output pinned before their call sites move"
    requirement: CLI-02
    verification:
      - kind: unit
        ref: "packages/cli/test/Inspection.test.ts, Migration.test.ts, Doctor.test.ts (npx vitest run --project cli: 224 passed, 1 skipped)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-11-14
status: complete
---

# Phase 1 Plan 01: Gate baseline and output pins Summary

**Measured gate baseline committed first (knip exit 1 on 39 untracked `.claude/` files plus 3 unlisted deps), then an 88-case plugin-view matrix and openapi / migration apply / config list pins, all green against untouched `packages/cli/src`.**

## Performance

- **Duration:** about 20 min (gates account for roughly 8 min of wall time)
- **Completed:** 2026-11-14
- **Tasks:** 3 (1 tracer, 2 auto/tdd)
- **Files:** 2 created, 3 modified; no file under `packages/cli/src` changed (`git diff --quiet a5ab6311 -- packages/cli/src` exits 0)

## Accomplishments

- `01-BASELINE.md` (commit 96c29821, alone and first) holds every gate's measured exit, summary line and time plus the raw `pnpm knip` output and the phase-close comparison rule.
- `PluginViews.test.ts` pins default, `--graph`, `--hooks`, `--rules`, `--events` across text, `--format json`, `--json`, `--format json + --json`, dot, dot + `--json` on `hookedApp` and `passwordAndRoles`; plus empty-row cells, selector precedence (hooks > rules > events > graph), nine real-argv cases and the failure-rendering rule (exit 9).
- `openapi`/`--json openapi` stdout parity, `migration apply` text tail (`applied N migration(s)`) and one-stdout-entry `--json` (apply and dry-run), and `config list` text/`--json` byte pins, all added without editing any existing case.

## Recorded baseline (measured on the untouched tree, HEAD 65f9a73a)

| Gate | Exit | Result | Wall |
|------|------|--------|------|
| `tsc -b tsconfig.json` | 0 | no output | 5 s |
| `tsc -p tsconfig.test.json` | 0 | 0 errors (2 pre-existing warnings in features/step-definitions/TestingHarnessSteps.ts) | 7 s |
| `pnpm test` | 0 | 409 files passed, 4 skipped; 6390 passed, 1 expected fail, 15 skipped | 98 s |
| `pnpm test:bdd` | 0 | 39 files; 1576 passed, 44 skipped | 16 s |
| `pnpm circular` | 0 | clean | 6 s |
| `pnpm spec:verify:strict` | 0 | PASS 32 / FAIL 0 / SKIP 0 | 58 s |
| `pnpm check:error-tags` | 0 | 163 internal and 137 wire, none shared | <1 s |
| `pnpm check:transactions` | 0 | no bare sql.withTransaction | 1 s |
| `pnpm coverage` | 0 | 91.61 / 85.08 / 86.8 / 92.14 (floors 89 / 83 / 84 / 90) | 105 s |
| `pnpm knip` | 1 (pre-existing) | Unused files (39), all `.claude/`; Unlisted dependencies (3) at packages/sql/test/fixtures/readme-quickstart.ts | 91 s |
| `pnpm lint` | 0 | warnings only (`.claude/`, RequestContextSteps.ts), no errors | 3 s |
| `pnpm format:check` | 0 | all 1204 files formatted | 1 s |
| `pnpm check:readmes` | 0 | match | 1 s |
| `pnpm workspace:check` | 0 | 29 packages, 3 examples | 1 s |
| `pnpm package:smoke` | 0 | PASS for every package | 81 s |

Postgres-gated tests: not run locally (`AWTHAQ_POSTGRES_URL` unset). `git diff --stat knip.json`: empty.

Difference from the orchestrator's orientation numbers: knip reports 39 unused files, not 140, because `.reports/` does not exist in this worktree (the 101 `.reports/` entries are absent; the 39 `.claude/` entries match). Every other number matches; wall times are lower (unit 98 s vs about 125 s, spec 58 s vs about 98 s).

## Task Commits

1. **Task 1 baseline:** `96c29821` docs(01-01): record gate baseline before any cli source change
2. **Task 1 tracer pin (hooks view):** `6dc0658f` test(01-01): pin the plugin list hooks view in every mode against untouched code
3. **Task 2 full matrix:** `c7543b9b` test(01-01): complete the plugin list view matrix, precedence, argv and failure pins
4. **Task 3 seam pins:** `4f4a5b8e` test(01-01): pin openapi, migration apply and config list output before their call sites move

The tracer gate ran on the hooks slice (17 cases green against untouched source) before the expansion task started.

## Decisions Made

- The resolution contract lives in the test as a three-line `resolve` function; expected output per cell is inline literals (default, `--graph` and dot for `hookedApp`, hooks, `hookedApp` rules) or the existing renderer applied to the builder with a literal head and line count (events, `passwordAndRoles` rules and `--graph`).
- Failure rendering is pinned at exit code 9 (`ConfigUnavailable`): `--format json` alone gives `awthaq: no configuration module in this test` on stderr, global `--json` gives one JSON failure document.
- The new Doctor `config list` block does not import `ConfigList`, so plan 01-03 can delete the module without touching it; the ECS-005 canary case still uses `ConfigList.show` and is for 01-03 to swap.

## Deviations from Plan

### Measured values that differ from the plan text

**1. [Rule 1 - plan data] `config list` first line for `configOf(passwordAndRoles)`**
- **Found during:** Task 3
- **Issue:** The plan says the first line is `core  awthaq/core/SessionConfig  (default)`; measured on untouched code it is `password  awthaq/password/Config  (default)` (the `core ...` line is present further down; the research figure came from the `hookedApp` config).
- **Fix:** Pinned the measured first line and added `assert.include(stdout, "core  awthaq/core/SessionConfig  (default)")`. No assertion was weakened.
- **Files modified:** packages/cli/test/Doctor.test.ts
- **Commit:** 4f4a5b8e

**2. [Rule 1 - plan data] `passwordAndRoles --graph` line count**
- **Found during:** Task 2
- **Issue:** Research and the plan note 16 lines; measured 15 (two nodes at seven lines each plus the footer, same as `hookedApp`).
- **Fix:** Pinned 15. Commit: c7543b9b.

### Other

- knip baseline is 39 unused files, not 140 (see above); recorded as measured.
- The tracer-slice file in commit 6dc0658f was extended in place in c7543b9b rather than rewritten, so the baseline commit still precedes the commit that adds the matrix.
- Mutation check (not committed): temporarily dropping `|| out.json` from the hooks branch of `Plugin.show` made 5 matrix cases fail; the source was restored with `git checkout -- packages/cli/src/Plugin.ts` and `git diff --quiet a5ab6311 -- packages/cli/src` exits 0.

**Total deviations:** 2 plan-data corrections (measured values), 0 behaviour changes. **Impact:** none on scope; the matrix pins today's output as measured.

## Issues Encountered

None. No gate other than knip failed at capture.

## Known Stubs

None.

## Threat Flags

None. T-01-01: `01-BASELINE.md` pastes only knip, `git status --short`, `git diff --stat knip.json` and gate summary lines; staged by explicit path. T-01-02: `knip.json` untouched and its diff recorded empty.

## Next Phase Readiness

Ready for 01-02 (views module): the matrix and `Inspection.test.ts` run unchanged before and after it. For 01-03: openapi, migration apply and config list pins exist; `Doctor.test.ts` still imports `ConfigList` for the ECS-005 canary case only.

## Self-Check: PASSED

- 01-BASELINE.md, PluginViews.test.ts present; commits 96c29821, 6dc0658f, c7543b9b, 4f4a5b8e are ancestors of HEAD.
- `npx vitest run --project cli`: 11 files passed, 1 skipped; 224 passed, 1 skipped. `npx tsc -p tsconfig.test.json`: 0 errors. `pnpm lint` exit 0, `pnpm format:check` exit 0. `git diff --quiet a5ab6311 -- packages/cli/src` exits 0.
