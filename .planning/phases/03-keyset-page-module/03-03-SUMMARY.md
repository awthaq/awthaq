---
phase: 03-keyset-page-module
plan: 03
subsystem: ports
tags: [keyset, pagination, ports, effect-order, spec-surface]

requires:
  - phase: 03-keyset-page-module
    provides: 03-01 baseline and golden cursor test, 03-02 pin matrix (the oracle this plan must not break)
provides:
  - "@awthaq/ports `Keyset` module: limit, Page, Request, Fetch, Direction, Key, key, Declaration, window, paginate"
  - Keyset.test.ts (contract against a fake fetch, parity with today's users and impersonation memory orders) and Keyset.types.test.ts (annotation-free declaration inference)
  - spec/overview.md Rev 1.18 listing `Keyset` in the ports surface
affects: [03-04, 03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 6000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "A listing declares its order once (`Declaration`: keys + cursorOf); the clamp, the single `limit + 1`, the trim, the next cursor and the memory comparator are derived from it"
    - "`key({ column, direction, order, row, cursor })` ties accessors and Order to one value type V and hides V in closures, so mixed-type keys share one tuple with no `any` and no `as`"

key-files:
  created:
    - packages/ports/src/Keyset.ts
    - packages/ports/test/Keyset.test.ts
    - packages/ports/test/Keyset.types.test.ts
  modified:
    - packages/ports/src/index.ts
    - spec/overview.md

key-decisions:
  - "Declaration shape is the plan's option C with no fallback: `Keyset.key` infers with no explicit type arguments and no parameter annotations (spike, below)"
  - "`window` computes 'follows the cursor' by walking the keys' `against` comparisons, first non-zero decides; it does not build a second comparator"
  - "Plan-head ledger not written to the git dir: the linked worktree's git dir lives under the other checkout, which the run must not touch; plan_head_before is c3d8878e, read from `git log` at start"

patterns-established:
  - "Adapters receive `Fetch { after, take }` and return up to `take` rows; only `paginate` adds the one"

requirements-completed: []

duration: 25min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: c3d8878ee5e9d3738c11d49d16c66bbc8b8ce266
plan_head_after: 91fd63fa97567bec1f56d272374ef374d662a1f6
---

# Phase 3 Plan 03: Keyset module in ports Summary

**`@awthaq/ports` gains `Keyset`: one declared order per listing, one `paginate` that owns the 1..200 clamp, the only `limit + 1`, the trim and the next cursor, and a memory `window` derived from the same keys; no listing adopts it yet.**

Requirements KEY-01 and the ports half of KEY-08 are delivered here; none is ticked by this plan (the orchestrator marks them at phase close). `requirements.mark-complete` was not run.

## Performance

- **Duration:** about 25 min
- **Tasks:** 2 of 2
- **Files:** 3 created, 2 modified; only the plan's `files_modified` changed

## Spike

**Inference outcome:** annotation-free inference succeeded. `Keyset.Declaration<Row, Cursor>` values whose keys are `Keyset.key({ ... })` calls with no type arguments and no parameter annotations compile, with a `DateTime.Utc` key (`DateTime.Order`) and a `string` key (`Order.String`) in one tuple, for both the users-shaped (asc, asc) and impersonation-shaped (desc, desc) declarations. Neither fallback (a) nor (b) was needed. `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` print no `error TS` (the `warning TS377149` lines are pre-existing, in `features/`).

**Chosen shape (03-04..03-07 build on it):**

```ts
Keyset.key({
  column: "createdAt", direction: "asc", order: DateTime.Order,
  row: (user) => user.createdAt, cursor: (cursor) => cursor.createdAt,
})
```

placed in `keys: [k1, ...rest]` of a `Keyset.Declaration<Row, Cursor>` with `cursorOf: (row) => Cursor`. `Key` keeps `column` and `direction` (03-04's `KeysetSql.make` reads exactly those) plus `rows` and `against` with the direction already applied. The row and cursor types come from the `Declaration<Row, Cursor>` annotation on the declaration value; a bare `key(...)` call outside such a context would need annotated accessor parameters.

**Emitted `packages/ports/lib/Keyset.d.ts`** (tsc -b output directory; `lib/` is gitignored):

```ts
export declare const key: <Row, Cursor, V>(spec: {
    readonly column: string;
    readonly direction: Direction;
    readonly order: Order.Order<V>;
    readonly row: (row: Row) => V;
    readonly cursor: (cursor: Cursor) => V;
}) => Key<Row, Cursor>;
export declare const window: <Row, Cursor>(declaration: Declaration<Row, Cursor>, rows: Iterable<Row>, fetch: Fetch<Cursor>) => ReadonlyArray<Row>;
export declare const paginate: <Row, Cursor, E, R>(declaration: Declaration<Row, Cursor>, request: Request<Cursor>, fetch: (fetch: Fetch<Cursor>) => Effect.Effect<ReadonlyArray<Row>, E, R>) => Effect.Effect<Page<Row, Cursor>, E, R>;
export interface Declaration<Row, Cursor> {
    readonly keys: readonly [Key<Row, Cursor>, ...Array<Key<Row, Cursor>>];
    readonly cursorOf: (row: Row) => Cursor;
}
```

**`@ts-expect-error` guarantees kept** (T-03-06 mitigation stands as written): a `row` accessor returning a type other than the order's value type is refused, and an empty `keys` tuple is refused; tsc reports no TS2578.

**No `as` / `any`:** `grep -vE '^\s*(//|\*|/\*)|^import ' packages/ports/src/Keyset.ts | grep -cE '\bas [A-Z{(]|\bany\b'` prints 0.

**A1 probe** (cursor-schema factory keyed by a computed field name, `<K extends string>(field: K) => Schema.Struct({ [field]: Schema.DateTimeUtc, id: Schema.String })` then reading `.startedAt` off `typeof schema.Type`): tsc gave `TS2322` ("Type 'string | Utc | undefined' is not assignable to type 'Utc'") and `TS4111` (property comes from an index signature). A1 holds: a computed key loses its literal type, so no cursor-schema factory; the three admin wire schemas stay as they are. The probe file `packages/ports/test/KeysetSpike.types.test.ts` was deleted and never committed.

## Accomplishments

- `Keyset.ts` (`effect/*` imports only): `limit` (undefined or non-finite -> 50, else truncate, clamp 1..200), `paginate` (clamps, one fetch with `take = limit + 1`, trims, `nextCursor` from `cursorOf` of the last kept row only when more than `limit` rows came back, a failing fetch fails untouched), `window` (sort by the combined key orders, strictly after the cursor, slice to `take`), `key` (a `desc` key flips both its row order and cursor comparison).
- Barrel line between `KeyProvider` and `LegacySessionBridge` and the spec edit (surface block, Ports row helper list, module row, Revision 1.18, Effective Date 2026-11-14, Change History entry) landed in one commit, so drift check 13 never failed between commits.
- Keyset.test.ts, 11 cases: limit table, take table (2->3, undefined->51, 10_000->201, 0->2, -3->2, 2.5->3, NaN->51, Infinity->51), `after` passed through by identity, exactly-full / limit+1 / fewer / empty pages, error passthrough, ascending and descending `window` parity with local copies of today's users and impersonation formulas across 9 rows with ties and mixed-case ids (`B1`, `a1`, `_x`, `A2`, `b0`, ...) at every cursor (none, each row, three off-row positions) and every take 1..10, code-unit ordering, equal and between cursors, single-key and mixed-direction declarations. Keyset.types.test.ts, 2 cases plus 2 `@ts-expect-error` lines.

## Task Commits

1. **Task 1: spike, module, barrel, surface entry, tracer case** - `8ee571ae` (feat)
2. **Task 2: full Keyset contract and parity tests** - `91fd63fa` (test)

## Gate results

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` | no `error TS` |
| `vitest run packages/ports/test/Keyset.test.ts packages/ports/test/Keyset.types.test.ts` | 13 passed |
| `pnpm spec:verify:strict` | PASS 32, FAIL 0, SKIP 0 |
| `pnpm circular` | exit 0, no cycle |
| `pnpm lint` | exit 0 (warnings only in `.claude/`, none in `packages/`) |
| `pnpm format:check` | all matched files use the correct format |
| non-comment `+ 1` count in Keyset.ts | 1 (inside `paginate`) |
| `as` / `any` outside comments and imports | 0 |
| workspace imports in Keyset.ts | 0 |
| temporary spike file | absent |
| `export * as` lines in the barrel | 32 (was 31) |
| exported names in Keyset.ts matching the `<interfaces>` list | 13 |
| filtered knip check (3 readme-quickstart rows present) | 0 lines; no Keyset finding |
| Wave 0 oracles KeysetCursors / KeysetPins / KeysetHttp (unedited) | 34 passed |

Postgres-gated cases: none in this plan; nothing run against Postgres (not run locally).

## Knip

No Keyset export or test file is flagged, as the plan predicted (namespace members of the ports entry are public to knip). The `<interfaces>` exports stay; recheck at the 03-09 phase-close gate once 03-04..03-07 consume them.

## Deviations from Plan

None - plan executed exactly as written. Two notes that are not deviations:

- The plan's Task 1 `<action>` asked the types test for "a runtime `it` asserting `paginate` over one declaration answers a page"; it uses `window` as the fake fetch, which also exercises the derived order.
- `git rev-parse --git-dir` for this linked worktree is under the other checkout, so the per-plan head ledger file was not written there; the base head was taken from the start-of-run `git log` and `commits: 2` was measured with `git rev-list --count c3d8878e..HEAD`.

## Known Stubs

None.

## Threat Flags

None. T-03-05 (clamp) is covered by the limit and take tables; T-03-06 (declaration type safety) by the two `@ts-expect-error` cases and the `as`/`any` grep.

## Next Phase Readiness

03-04 can read `Key.column` and `Key.direction` from a `Declaration` and build the row-value predicate; 03-05..03-07 write their declarations in the shape above and replace their adapters' `+ 1`, trim and memory comparator with `paginate` and `window`.

## Self-Check: PASSED

- FOUND: packages/ports/src/Keyset.ts, packages/ports/test/Keyset.test.ts, packages/ports/test/Keyset.types.test.ts
- FOUND commits 8ee571ae, 91fd63fa (ancestors of HEAD)
