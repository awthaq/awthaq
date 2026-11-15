---
phase: 01-cli-views-and-configlist-removal
plan: 03
subsystem: cli
tags: [cli, effect, config-list, openapi, migration, output]

requires:
  - phase: 01-01
    provides: "Wave 0 byte pins for config list, openapi and migration apply"
  - phase: 01-02
    provides: "Output.report optional { json } override (not used by this plan's call sites)"
provides:
  - "config list handler inline in Cli.ts with private renderConfigItems"
  - "ConfigList module and its barrel export removed"
  - "Openapi.emit stdout and Migration.apply finish on the Output.report seam"
affects: [01-04]

actuals:
  tokens: 3000
  tasks: 2
  commits: 2
plan_head_before: 7e4d6eaa22be0a5da4835d458d7eeed9056de78f
plan_head_after: cf6d018862e56af8e95ab66f3b300abf61bc598c

tech-stack:
  added: []
  patterns:
    - "A command whose output is one value plus a text renderer calls Output.report instead of branching on the global json flag"

key-files:
  created: []
  modified:
    - packages/cli/src/Cli.ts
    - packages/cli/src/index.ts
    - packages/cli/src/Openapi.ts
    - packages/cli/src/Migration.ts
    - packages/cli/test/Doctor.test.ts
  deleted:
    - packages/cli/src/ConfigList.ts

key-decisions:
  - "Migration.apply's text status preview stays hand-guarded (see Seam adoption verdicts)"
  - "Doctor.configContext and Doctor.descriptorsOf keep their exports; Cli.ts now uses them and knip reports nothing new"

requirements-completed: [CLI-03, CLI-04]

coverage:
  - id: D1
    description: "config list runs from an inline handler with byte-identical text and --json output; ConfigList is gone from src, barrel and packages/"
    requirement: CLI-03
    verification:
      - kind: unit
        ref: "packages/cli/test/Doctor.test.ts (config list byte pin and ECS-005 canary over runCli); npx vitest run --project cli: 224 passed, 1 skipped"
        status: pass
      - kind: other
        ref: "grep -rn ConfigList packages --exclude-dir=node_modules --exclude-dir=lib => 0 lines; test ! -e packages/cli/src/ConfigList.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Openapi.emit and Migration.apply finish write through Output.report with identical stdout, stderr and documents"
    requirement: CLI-04
    verification:
      - kind: unit
        ref: "packages/cli/test/Inspection.test.ts and Migration.test.ts unedited since 7e4d6eaa; Wave 0 openapi parity and migration apply pins pass; pnpm test:bdd 1576 passed"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-14
status: complete
---

# Phase 1 Plan 03: ConfigList removal and Output seam adoption Summary

**`awthaq config list` is now an inline handler in Cli.ts (the ConfigList module and its barrel export are deleted), and `openapi` stdout plus `migration apply`'s plan document and applied line go through `Output.report`, all with the Wave 0 byte pins green and unedited.**

## Accomplishments

- `Cli.ts`: private `renderConfigItems` (same line format, BEH-EA-229 / BEH-EA-201 citation moved with it) and a `configList` handler that yields `Doctor.configContext(config)`, reads `EffectiveConfig.read(context, Doctor.descriptorsOf(config))` and calls `Output.report(items, renderConfigItems)`. Header paragraph amended so "every command body lives in its own module" stays true.
- `ConfigList.ts` removed with `git rm`; `export * as ConfigList` removed from `index.ts`; nothing under `packages/` names the module.
- `Doctor.test.ts`: the ECS-005 canary now calls `runCli(["config", "list"], config)` and joins `stdout`; every include/notInclude assertion unchanged; only the module import was dropped (`Output`, `Ref`, `EffectiveConfig` are still used elsewhere in the file).
- `Openapi.emit` no-`--out` branch is `Output.report(spec, () => [text])`; the `--out` branch is untouched.
- `Migration.apply`: `finish(applied)` is `Output.report({ pending, drift, applied }, ...)` whose renderer emits `applied N migration(s)` only when the document's `applied` is true; the trailing hand-written applied line is deleted. `finish(true)` still follows `Migrations.apply`.

## Seam adoption verdicts

| Call site | Verdict | Reason |
|-----------|---------|--------|
| `Openapi.emit` stdout | Moved to `Output.report` | `--json` document is `JSON.stringify(spec, null, 2)`, the same bytes as the text line; Wave 0 parity pin passes |
| `Migration.apply` `finish` | Moved to `Output.report` (absorbs the applied line) | The document (json) and applied line (text) are both emitted at the end of the run, after the write |
| `Migration.apply` status preview (`renderStatus` lines, text only) | Left hand-guarded | It prints before the drift and pending checks while the document prints at the end; `Output.report` couples text and document at one point, so moving it would reorder text output or double-print |
| `Migration.status` | Already on the seam | `Output.report(report, renderStatus)` |

## Task Commits

1. **Task 1 (tracer):** `9932ef0f` feat(01-03): inline config list into Cli.ts and remove the ConfigList module
2. **Task 2:** `cf6d0188` feat(01-03): route Openapi.emit stdout and Migration.apply finish through Output.report

Tracer gate (auto config absent, `end-of-phase`, automated-only verify): re-ran the verify end to end (vitest cli, tsc -b, tsc test, lint, grep) before expanding; it passed.

## Acceptance results

| Check | Result |
|-------|--------|
| `npx vitest run --project cli` | 11 files passed, 1 skipped; 224 passed, 1 skipped |
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` | 0 `error TS` (only the 2 pre-existing TestingHarnessSteps warnings) |
| `pnpm lint`, `pnpm format:check`, `pnpm circular`, `pnpm check:error-tags`, `pnpm check:transactions` | exit 0 |
| `pnpm test:bdd` (after `tsc -b`) | 39 files; 1576 passed, 44 skipped (same as baseline) |
| `pnpm knip` | no finding under packages/, examples/, features/, scripts/, spec/ beyond the 3 readme-quickstart.ts rows (the remaining rows are untracked `.claude/` files) |
| `grep -rn ConfigList packages (no node_modules, lib)` | 0 lines; `test ! -e packages/cli/src/ConfigList.ts` passes |
| `grep -c renderConfigItems` / `EffectiveConfig` in Cli.ts | 2 / 4 |
| `grep -cF 'clientSecret = <redacted>'` in Doctor.test.ts | 1 |
| `grep -c 'out\.document'` / `out.line(\`applied` in Migration.ts | 0 / 0 |
| `grep -c Output.report` Openapi.ts / Migration.ts | 2 / 2 |
| `git diff 7e4d6eaa -- Inspection.test.ts Migration.test.ts` | empty |

Postgres-gated tests: not run locally. `pnpm package:smoke` and `pnpm clean` are 01-04's.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. T-01-06 (`clientSecret = <redacted>`, `signingKey = <redacted>`, `databaseUrl = postgres://app:<redacted>@db.internal/app` over real argv through `runCli`), T-01-07 (openapi parity pin) and T-01-08 (`finish(true)` stays after `Migrations.apply`; applied line once, only on `--yes`) hold.

## Next Phase Readiness

Ready for 01-04 (changeset, spec and traceability edits): the code half of CLI-03 is done; the spec still cites `ConfigList.ts` at `spec/behaviors/26-cli.md` and that grep is 01-04's. A stale `packages/cli/lib/ConfigList.*` may remain until `pnpm clean`.

## Self-Check: PASSED

- Commits 9932ef0f and cf6d0188 are ancestors of HEAD; `git rev-list --count 7e4d6eaa..HEAD` was 2 before this SUMMARY.
- `packages/cli/src/ConfigList.ts` absent; `01-03-SUMMARY.md` present.
