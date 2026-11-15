---
phase: 01-cli-views-and-configlist-removal
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/01-cli-views-and-configlist-removal/01-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-11-14
**Source review:** .planning/phases/01-cli-views-and-configlist-removal/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (WR-01, IN-04, IN-01, as scoped by the caller)
- Fixed: 3
- Skipped: 0

IN-02 and IN-03 were explicitly out of scope (accepted), as was the changeset bump level. They remain open in REVIEW.md.

**Verification ran in the main checkout** (`workflow.use_worktrees` is `false`; no worktree was created).

## Fixed Issues

### WR-01: No test pins that a failed or refused `migration apply` emits no `applied` line and a single document

**Files modified:** `packages/cli/test/Migration.test.ts`
**Commit:** a29c74be (shared with IN-04, same file and shared `freshPlan` helper)
**Applied fix:** Six new `Migration.apply` cases, `Output.capture`-based, no `as`/`!`:
- `--json` on a drifted ledger: exit 7, documents equal `[{ pending: [], drift: true, applied: false }]`, stdout is that one document.
- text on a drifted ledger: exit 7, DRIFT shown, no stdout line starts with `applied `.
- `--json` without `--yes`: exit 6, one document `{ pending: <plan>, drift: false, applied: false }`, nothing written.
- text without `--yes`: exit 6, no `applied ` line, nothing written.
- (d) mid-write failure, feasible with existing fixtures: a pre-created `users` table makes core migration 1 fail inside `Migrations.apply`. Under `--json` no document and no stdout at all; in text the plan is printed but no `applied ` line.

The `run` helper now also returns `documents`.

Mutation check: moving `finish(true)` ahead of `Migrations.apply` in `packages/cli/src/Migration.ts` made 5 tests fail, including both new mid-write-failure tests (the three others were existing success-path tests that saw a duplicate document or line). The file was restored with `git checkout --` and `git diff --quiet HEAD` confirmed it clean before any commit.

### IN-04: Convoluted assertions in the new `Migration.apply` JSON tests

**Files modified:** `packages/cli/test/Migration.test.ts`
**Commit:** a29c74be
**Applied fix:** Both `Object.entries(...).filter(...)` assertions replaced with `assert.deepStrictEqual(docs[0], { pending, drift: false, applied })`. `pending` comes from a `freshPlan` helper: core entries derived from `CoreMigrations.coreMigrations` (not hardcoded, since other programs add core migrations) plus the two plugin entries as inline literals. `drift` and `pending` are now pinned.

### IN-01: `Openapi.emit` now depends on `Output.stringify` matching its own `JSON.stringify(spec, null, 2)`

**Files modified:** `packages/cli/src/Openapi.ts`
**Commit:** 2769b62f
**Applied fix:** The `Output.report` move was kept (locked decision). Added a two-line comment at the call site stating the stdout text is the same `JSON.stringify(spec, null, 2)` bytes as `Output.stringify`, pinned by the BEH-EA-205 parity test in Inspection.test.ts. The file header sentence was left alone: it still reads correctly (it already names `Output.report` and the same-bytes property).

## Verification

- `npx vitest run --project cli`: exit 0, 230 passed, 1 skipped (224 prior plus 6 new).
- `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json`: 0 `error TS`.
- `pnpm lint`: exit 0 (warnings only, all in untracked `.claude/gsd-core`).
- `pnpm format:check`: pass. `npx oxfmt` run on both edited `.ts` files.

---

_Fixed: 2026-11-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
