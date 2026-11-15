---
phase: 01-cli-views-and-configlist-removal
reviewed: 2026-11-14T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - packages/cli/src/Cli.ts
  - packages/cli/src/ConfigList.ts (deleted)
  - packages/cli/src/Migration.ts
  - packages/cli/src/Openapi.ts
  - packages/cli/src/Output.ts
  - packages/cli/src/Plugin.ts
  - packages/cli/src/PluginViews.ts
  - packages/cli/src/index.ts
  - packages/cli/test/Doctor.test.ts
  - packages/cli/test/Inspection.test.ts
  - packages/cli/test/Migration.test.ts
  - packages/cli/test/PluginViews.test.ts
findings:
  critical: 0
  warning: 1
  info: 4
  total: 5
  necessity: 1
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

I diffed every moved call site against `65f9a73a` and found no behavioural regression and no convention violation. I found no `as`, `!` or new return-type annotation in the changed source.

- **`Plugin.show` and `PluginViews.render`:** This matches the old branch table exactly.
  - hooks, rules and events have no DOT branch, so `--format dot` prints their text, or their document under `--json`.
  - The graph and the plain list print DOT even under `--json`.
  - `json` or the global `--json` gives one document.
  - Selector precedence is unchanged: hooks, then rules, then events, then graph, then the plain list.
  - `options?.json ?? out.json` is sound. `render` always passes a boolean, so the fallback is only used by callers that omit the option.
- **`config list`:** The inlined renderer and the `configContext`/`read`/`report` sequence are identical to the deleted `ConfigList.show`.
- **`Openapi.emit`:** The `--json` document and the old text line are the same bytes, because both go through `JSON.stringify(spec, null, 2)`.
- **`Migration.apply`:** Ordering is preserved. `finish(true)` runs only after `Migrations.apply` succeeds, so a `SqlError`, `LedgerDrift` or `MigrationFailed` still emits neither the document nor the `applied N migration(s)` line. In text mode `finish(false)` renders `[]`, so nothing extra is printed. In `--json` mode it emits exactly one document.
- **`@awthaq/cli` public export:** Dropping the `ConfigList` export from `index.ts` is the only API change. The changeset is `minor` and documents the migration path. That bump is questionable for a pre-1.0 removal; I did not verify that against the repo's versioning policy.

The one real gap is a missing test for the failure path of `Migration.apply`. The rest is polish.

## Warnings

### WR-01: No test pins that a failed or refused `migration apply` emits no `applied` line and a single document

**File:** `packages/cli/test/Migration.test.ts:162-231`
**Issue:** The change moved the `applied N migration(s)` line from a trailing `if (!out.json)` into the `finish` callback. The new tests cover only the two success shapes, `--yes` and `--dry-run`, in text and `--json`. The ordering and failure invariants this refactor could break have no direct assertion:
- On drift, `finish(false)` prints the plan, then the failure follows. Under `--json` it must be one document with `applied:false`. Under text it must print no `applied` line. The existing drift test checks only exit code 7.
- On `ConfirmationRequired` (no `--yes`), the same holds.
- If `Migrations.apply` fails midway (`MigrationFailed`/`SqlError`), no document and no `applied` line may appear. This is the "applied N" printed before the write succeeded scenario, and nothing guards it.

A later reorder of `finish(true)` ahead of the write would pass every test added here.
**Fix:** Add capture-based cases, for example:
```ts
it.effect("drift under --json: one document, applied false, then LedgerDrift", () =>
  Effect.gen(function* () {
    yield* run(Migration.apply(passwordAndRoles, yes));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (500, 'unknown_core')`;
    const { captured, layer } = yield* Output.capture(true);
    const exit = yield* Effect.exit(Migration.apply(passwordAndRoles, yes).pipe(Effect.provide(layer)));
    assert.strictEqual(failureCode(exit), 7);
    const docs = yield* Ref.get(captured.documents);
    assert.strictEqual(docs.length, 1);
    assert.strictEqual((docs[0] as { applied: boolean }).applied, false);
  }).pipe(Effect.provide(Sql)),
);
```
Add the text counterpart. In it, assert that no stdout line starts with `applied ` after a `ConfirmationRequired` or `LedgerDrift` failure.

## Info

### IN-01: `Openapi.emit` now depends on `Output.stringify` matching its own `JSON.stringify(spec, null, 2)`

**File:** `packages/cli/src/Openapi.ts:32-33`
**Issue:**
- The file header says `--json` "changes nothing here". That is now true only because `Output.stringify` is `JSON.stringify(value, null, 2)`, the same call as line 31.
- Changing `Output.stringify` (compact output, a different indent) would silently make `openapi` stdout differ from the `--out` file bytes and from the text line. Nothing couples the two.
- The `() => [text]` render callback ignores its argument. Under `--json` the spec is stringified twice.
- Under `Output.capture`, `documents` now also records the spec for a command that is defined as "always the document", so tests observe a channel change.
- The new test `BEH-EA-205: --json prints the same bytes as text` does pin the equality, which mitigates the first point.

**Fix:** Either keep the direct `out.line(text)` and drop the `Output.report` hop, since the old code was simpler and carried no coupling, or document the coupling at the call site. Do not rely on the unrelated header comment.

### IN-02: `PluginViews.render` encodes "has a DOT renderer" twice

**File:** `packages/cli/src/PluginViews.ts:27-38`
**Category:** necessity
**Issue:** `resolve(..., hasDot)` receives `view.dot !== undefined`, and `render` re-tests `dot !== undefined` to narrow the type for the call. When `mode === "dot"` the second check can never be false, so it is a type-narrowing guard, not a real branch. This rests on judgment, not repo evidence, because the aim is avoiding `!`. Computing the mode from `dot` directly removes the redundancy:
**Fix:**
```ts
const dot = view.dot;
const mode = dot !== undefined && format === "dot" ? "dot" : format === "json" || out.json ? "json" : "text";
if (mode === "dot") return yield* Output.report(rows, dot, { json: false }); // TS cannot narrow via mode; keep the guard or restructure
```
Alternatively leave as is. This is not worth a change if TS narrowing makes the rewrite longer.

### IN-03: `config list` test and the matrix tests derive part of their expected values from the code under test

**File:** `packages/cli/test/Doctor.test.ts:301-326`, `packages/cli/test/PluginViews.test.ts:115,161,181-182`
**Issue:**
- The `config list` test rebuilds `lines` with a copy of the renderer. It uses `EffectiveConfig.read` and `Doctor.configContext` for the expected value, then asserts two literals. A regression in `EffectiveConfig.read` or `configContext`, such as a wrong source label or an unredacted value, changes both sides, so only the two literal lines would catch it.
- The `passwordAndRoles` expectations for `--graph`, `--rules` and `--events` are `Plugin.renderText`, `Plugin.renderRules` and `Plugin.renderEvents` applied to the builders. The `pinned` head and line count partly offset this, but the middle lines are not independently pinned.
- The matrix `resolve` function mirrors `PluginViews.resolve`. It is an independent statement of the contract, which is acceptable, but a copy-paste of the same logic would pass for the wrong reason.

**Fix:** Pin a few more literal lines for `passwordAndRoles` per view. Pin the full `config list` stdout for `passwordAndRoles` inline, or at least every `owner  key  (source)` header line.

### IN-04: Convoluted assertions in the new `Migration.apply` JSON tests

**File:** `packages/cli/test/Migration.test.ts:200-205,223-228`
**Issue:** `Object.entries(docs[0] ?? {}).filter(([key]) => key === "applied")` followed by `deepStrictEqual(..., [["applied", true]])` is a roundabout way to read one field. This looks like a workaround for not using `as` in tests. It also does not pin `pending` or `drift` content.
**Fix:** Assert the whole document, for example `assert.deepStrictEqual(docs[0], { pending: expectedPending, drift: false, applied: true })`, or `assert.include(docs[0], { applied: true, drift: false })`.

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
