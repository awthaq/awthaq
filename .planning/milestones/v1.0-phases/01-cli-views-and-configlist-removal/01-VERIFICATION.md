---
phase: 01-cli-views-and-configlist-removal
verified: 2026-11-14T04:30:00Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - ".changeset/cli-plugin-views-config-list.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-01-PLAN.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-01-SUMMARY.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-02-PLAN.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-02-SUMMARY.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-03-PLAN.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-03-SUMMARY.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-04-PLAN.md"
  - ".planning/phases/01-cli-views-and-configlist-removal/01-04-SUMMARY.md"
  - "packages/cli/src/Cli.ts"
  - "packages/cli/src/Migration.ts"
  - "packages/cli/src/Openapi.ts"
  - "packages/cli/src/Output.ts"
  - "packages/cli/src/Plugin.ts"
  - "packages/cli/src/PluginViews.ts"
  - "packages/cli/src/index.ts"
  - "packages/cli/test/PluginViews.test.ts"
  - "spec/behaviors/26-cli.md"
  - "spec/traceability.md"
covered_digest: "v4:sha256:8713b1431e2a0aff4892298975255e2e8561d5bd9c050e095e48803be1f2aec8"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 1: CLI views and ConfigList removal Verification Report

**Phase Goal:** Maintainers render every `plugin` view through one views module that resolves output format once, and the gate baseline is recorded so every later phase is checked against it.
**Verified:** 2026-11-14
**Status:** passed
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Knip baseline recorded before any code change; all gates pass against it at phase close | VERIFIED | `01-BASELINE.md` committed in `96c29821`, which precedes every `packages/cli/src` commit (first is `3d58e1f8`). Re-run by the verifier: `tsc -b` 0, `pnpm circular` 0, `pnpm lint` 0 (warnings only), `pnpm check:error-tags` ok, `pnpm check:transactions` ok, `pnpm spec:verify:strict` PASS 32 / FAIL 0, `pnpm test:bdd` 1576 passed, `pnpm coverage` 6490 passed (baseline 6390, grew only) at 91.65 / 85.08 / 86.91 / 92.17 against floors 89 / 83 / 84 / 90, `pnpm knip` output outside `.claude/` and `.reports/` is exactly the three baseline `readme-quickstart.ts` unlisted-dependency rows (39 unused files, all under `.claude/`, same as baseline), `git diff --stat knip.json` empty. |
| 2 | Mode x (text, `--format json`, `--json`, dot) matrix for hooks/rules/events/graph committed passing against pre-refactor code and unchanged afterwards | VERIFIED | Git order: `96c29821` baseline, `6dc0658f` matrix (hooks), `c7543b9b` matrix completion, `4f4a5b8e` openapi/migration/config pins, then the first `packages/cli/src` change `3d58e1f8`. `git log` on `PluginViews.test.ts` shows only those two test commits, and `git diff c7543b9b HEAD` on it is empty, so the matrix is byte-identical from its pre-refactor completion to HEAD. Literal reading of "first commit to HEAD additions only" does not hold for `6dc0658f`: the first commit pinned hooks only and `c7543b9b` (also pre-refactor, before any src change) restructured `views` from `[hooksView]` to five views and moved the hooks argv cases. That restructuring precedes the refactor, so it is not an expected-value edit made to fit new code. Other pins (`Inspection.test.ts`, `Doctor.test.ts`, `Migration.test.ts`) after `4f4a5b8e`: `Inspection.test.ts` unchanged; `Doctor.test.ts` only drops the `ConfigList` import and drives `runCli(["config","list"])` with identical assertions; `Migration.test.ts` only changes in review-fix `a29c74be` (additions plus two assertions made whole-document, the allowed exception). `npx vitest run --project cli`: 11 files passed, 1 skipped, 230 passed, 1 skipped. |
| 3 | All four plugin views render through one views module resolving `--format` and `--json` once, output identical | VERIFIED | `packages/cli/src/PluginViews.ts` holds `resolve()` and `render()`. `Plugin.ts` lines 290 to 294 route hooks, rules, events, graph and the default list through `PluginViews.render`; no other `--format`/`--json` resolution remains in `Plugin.ts` or `Cli.ts` for `plugin list`. DOT beats `--json` only when the view has a `dot` renderer (graph and list); hooks/rules/events have none. Pinned matrix passes unchanged (truth 2). |
| 4 | `ConfigList` absent from export and tree; changeset with `Migration:` line; `26-cli.md` Revision and Change History bumped together | VERIFIED | `packages/cli/src/ConfigList.ts` deleted, export removed from `index.ts`; grep over `packages/`, `spec/`, `docs/`, `examples/` finds no `ConfigList`; the only remaining hits are `.changeset/cli-plugin-views-config-list.md` (the Migration text) and `.planning/` docs. Changeset is `"@awthaq/cli": minor` with a `Migration:` line. `spec/behaviors/26-cli.md` Revision 1.9 to 1.10, Effective Date 2026-11-14, Change History entry 1.10 added in the same change; the two *Implementation* notes (BEH-EA-201 and BEH-EA-229, formerly lines 46 and 398) now cite `Cli.ts (config list)`. `spec/traceability.md` Revision 1.88 to 1.89 with a `PluginViews.test.ts` row. |
| 5 | `Migration.apply` and `Openapi` write through the same `Output` seam where it costs no behaviour change | VERIFIED | `Migration.ts` `finish` now calls `Output.report` (document under `--json`, `applied N migration(s)` line in text only after a write); `Openapi.emit` stdout path calls `Output.report(spec, () => [text])` with the byte-equality coupling documented (IN-01). Their pre-refactor pins (`4f4a5b8e`) pass; `Migration.test.ts` assertions were only added or tightened in review fix `a29c74be`, never loosened. `--out <file>` path correctly stays on `FileSystem` (not stdout). |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Status | Details |
|---|---|---|
| `packages/cli/src/PluginViews.ts` | VERIFIED | Substantive (`View`, `resolve`, `render`), imported and used by `Plugin.ts` |
| `packages/cli/src/Output.ts` | VERIFIED | `report` gains optional `{ json }` override; existing callers unaffected |
| `packages/cli/src/Plugin.ts` | VERIFIED | Five views as descriptors, one `PluginViews.render` call per branch |
| `packages/cli/src/Cli.ts` | VERIFIED | `config list` handler calls `Output.report(items, renderConfigItems)` |
| `packages/cli/test/PluginViews.test.ts` | VERIFIED | Matrix, literal text pins, precedence, real argv, failure rendering |
| `.changeset/cli-plugin-views-config-list.md` | VERIFIED | minor bump, `Migration:` line |
| `01-BASELINE.md` | VERIFIED | Complete per-gate table, raw knip output, comparison rule |

### Key Link Verification

| From | To | Status |
|---|---|---|
| `Plugin.list` | `PluginViews.render` | WIRED (5 call sites) |
| `PluginViews.render` | `Output.report` with `{ json }` override | WIRED |
| `Migration.apply` / `Openapi.emit` | `Output.report` | WIRED |
| `Cli.ts config list` | `Output.report` | WIRED |

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| CLI-01 | 01-02 | SATISFIED | Truth 3 |
| CLI-02 | 01-01 | SATISFIED | Truth 2 |
| CLI-03 | 01-03, 01-04 | SATISFIED | Truth 4 |
| CLI-04 | 01-03 | SATISFIED | Truth 5 |
| GATE-01 | 01-04 | SATISFIED | Truth 1 (gates re-run) |
| GATE-02 | 01-01 | SATISFIED | `01-BASELINE.md`, committed before any src change |
| GATE-03 | 01-04 | SATISFIED | One changeset with `Migration:` line; spec Revision and Change History bumped together |

All seven IDs appear in plan frontmatter and in REQUIREMENTS.md (marked Complete); no orphaned requirements for Phase 1. GATE-04 is mapped to Phase 3, not this phase.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers in the changed `packages/cli/src` files; no stubs. `render` returns void effects, no placeholder returns.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| CLI project tests | `npx vitest run --project cli` | 230 passed, 1 skipped | PASS |
| Typecheck | `npx tsc -b tsconfig.json` | exit 0 | PASS |
| Cycles | `pnpm circular` | exit 0 | PASS |
| Lint | `pnpm lint` | exit 0, warnings only | PASS |
| BDD | `pnpm test:bdd` | 1576 passed, 44 skipped | PASS |
| Coverage + unit | `pnpm coverage` | 6490 passed, floors met | PASS |
| Spec | `pnpm spec:verify:strict` | PASS 32 FAIL 0 | PASS |

### Probe Execution

No phase probes declared.

### Notes (not gaps)

- Postgres-gated tests (`Migration.postgres.test.ts`, `AWTHAQ_POSTGRES_URL` unset) were not run locally; expected for this phase and recorded in the baseline.
- Known and already triaged, not raised: 01-REVIEW.md IN-02 and IN-03 (skipped with reasons in `01-REVIEW-DISPOSITION.md`), and the `--json config list` canary asymmetry in `01-SECURITY.md`.
- The ROADMAP checklist line for Phase 1 still shows `[ ]` under "Phases"; an orchestrator bookkeeping matter, not a codebase gap.

### Human Verification Required

None.

### Gaps Summary

None. The phase goal is achieved in the code: one `PluginViews` module resolves format once for every `plugin list` view, `ConfigList` is gone with a Migration changeset and bumped spec, `Migration.apply` and `Openapi` use the `Output` seam, and the baseline was recorded before any source change with every gate still matching it.

---

_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
