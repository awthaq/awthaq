---
phase: 01-cli-views-and-configlist-removal
plan: 02
subsystem: cli
tags: [cli, effect, plugin-list, output, views]

requires:
  - phase: 01-01
    provides: "PluginViews.test.ts mode x view matrix, Inspection.test.ts, gate baseline"
provides:
  - "packages/cli/src/PluginViews.ts: Format, View<A>, render; one private resolver for --format and global --json"
  - "Output.report optional { json } override (additive)"
  - "Plugin.ts five view descriptors; Plugin.show is a selector only"
affects: [01-03, 01-04]

actuals:
  tokens: 1500
  tasks: 2
  commits: 2
plan_head_before: 735f118a522a84ba36de8d6a6bc4857a91bf44e9
plan_head_after: 2233dd7b66617b3b9d4e0e78e6646cdf702094a7

tech-stack:
  added: []
  patterns:
    - "View descriptor (rows, text, optional dot) plus one render that resolves the output mode once and hands Output.report an explicit { json }"

key-files:
  created:
    - packages/cli/src/PluginViews.ts
  modified:
    - packages/cli/src/Output.ts
    - packages/cli/src/Plugin.ts

key-decisions:
  - "DOT is printed through Output.report(rows, dot, { json: false }) so the global flag cannot turn it into a document; every other mode passes { json: mode === 'json' }"
  - "Plugin.show returns the PluginViews.render effect of the selected descriptor directly (no Effect.gen), so the differing row types need no union or cast"
  - "The plain list view carries a DOT renderer (dot beats --json for default and --graph alike), matching the Wave 0 matrix"

patterns-established:
  - "A command with its own --format flag resolves the mode and passes it to Output.report; failures stay on the global flag"

requirements-completed: [CLI-01]

coverage:
  - id: D1
    description: "All five plugin list views render through PluginViews.render; Plugin.ts no longer reads the global json flag or the Output service"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/PluginViews.test.ts, Inspection.test.ts (npx vitest run --project cli: 224 passed, 1 skipped, tests unedited)"
        status: pass
      - kind: other
        ref: "grep -c 'out\\.json' packages/cli/src/Plugin.ts => 0; grep -c 'Output\\.Output' => 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Output.report override is additive and failure rendering is unchanged"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "PluginViews.test.ts failure-rendering cells and ExitCodes.test.ts (npx vitest run --project cli)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Barrel surface and cycle check unchanged"
    requirement: CLI-01
    verification:
      - kind: other
        ref: "pnpm circular exit 0; git diff packages/cli/src/index.ts and packages/cli/test empty vs 735f118a"
        status: pass
    human_judgment: false

duration: 2min
completed: 2026-11-14
status: complete
---

# Phase 1 Plan 02: Plugin list views module Summary

**Every `awthaq plugin list` view (default, `--graph`, `--hooks`, `--rules`, `--events`) now renders through one `PluginViews.render` that resolves `--format` and the global `--json` once, with the 88-case Wave 0 matrix green and unedited.**

## Performance

- **Duration:** about 2 min of edits plus gate runs
- **Started:** 2026-11-14T02:44:07Z
- **Tasks:** 2 (1 tracer, 1 auto/tdd)
- **Files:** 1 created, 2 modified (`Output.ts`, `PluginViews.ts`, `Plugin.ts`); no test and no barrel change

## Accomplishments

- `Output.report` takes an optional third parameter `{ json?: boolean | undefined }` and tests `options?.json ?? out.json`; `failure`, `failureDocument`, `capture` and `layerConsole` are untouched.
- `PluginViews.ts` (imports only `Output` and the `LoadedAuth` type): `Format`, `View<A>` and `render`, with a private `resolve(format, globalJson, hasDot)` giving dot, json or text.
- `Plugin.ts`: `hooksView`, `rulesView`, `eventsView`, `graphView`, `listView` descriptors; `show` is an if-chain selector (hooks > rules > events > graph > list) with the same name and options; `Format` is an alias of `PluginViews.Format`; all builders and renderers stay exported as test oracles; the `Effect` and `Output` imports are gone.

## Task Commits

1. **Task 1 (tracer):** `3d58e1f8` feat(01-02): route the plugin list hooks view through PluginViews.render
2. **Task 2:** `2233dd7b` feat(01-02): plugin list rules, events, graph and default views as descriptors

Tracer gate (auto-config absent, `end-of-phase`, automated-only verify): re-ran the verify end to end before expanding; it passed.

## Acceptance results

| Check | Result |
|-------|--------|
| `npx vitest run --project cli` | 11 files passed, 1 skipped; 224 passed, 1 skipped |
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` | exit 0 (only the 2 pre-existing TestingHarnessSteps warnings) |
| `pnpm circular`, `pnpm lint`, `pnpm format:check` | exit 0 |
| `pnpm check:error-tags`, `pnpm check:transactions` | pass (163 internal / 137 wire, none shared; no bare withTransaction) |
| `pnpm test:bdd` | 39 files; 1576 passed, 44 skipped (same as baseline) |
| `grep -cF 'json?: boolean' Output.ts` | 1 |
| `grep -c 'PluginViews.render' Plugin.ts` | 5 |
| `grep -c 'out\.json'` / `'Output\.Output'` in Plugin.ts | 0 / 0 |
| `export const show` / `export type Format` in Plugin.ts | 1 / 1 |
| `from "./Plugin.ts"` in PluginViews.ts | 0 |
| `git diff 735f118a -- packages/cli/test packages/cli/src/index.ts` | empty |

Postgres-gated tests: not run locally.

## Deviations from Plan

None - plan executed exactly as written. (Minor: `show` returns the selected `render` effect directly instead of wrapping it in `Effect.gen`, which satisfies "select with an if/ternary chain" and drops the now-unneeded `Effect` import.)

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. T-01-03 (the formatJson, dot and dotGlobalJson matrix cells), T-01-04 (`Output.failure` and `failureDocument` unedited, failure cells and ExitCodes pass) and T-01-05 (rows are the unchanged builders; JSON cells deepStrictEqual the builder output) hold.

## Next Phase Readiness

Ready for 01-03 (Cli.ts, ConfigList.ts, index.ts, Doctor.test.ts, Openapi.ts, Migration.ts): `Output.report` accepts the optional override its new call sites do not pass, and none of this plan's files overlap 01-03's.

## Self-Check: PASSED

- `packages/cli/src/PluginViews.ts` present; commits 3d58e1f8 and 2233dd7b are ancestors of HEAD; `git rev-list --count 735f118a..HEAD` was 2 before this SUMMARY.
