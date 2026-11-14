---
phase: 03-keyset-page-module
plan: 04
subsystem: sql
tags: [keyset, pagination, sql, row-value, spec-surface]

requires:
  - phase: 03-keyset-page-module
    provides: 03-03 `Keyset.Declaration` / `Keyset.key` / `Keyset.window` in @awthaq/ports
provides:
  - "@awthaq/sql `KeysetSql`: make, Seek (after, orderBy)"
  - KeysetSql.test.ts (memory-SQL agreement on TestSql, compiled shape, refusals, escaping)
affects: [03-05, 03-06, 03-07, 03-08, 03-09]

actuals:
  tokens: 5000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "One declaration, two adapters: the SQL seek reads `Key.column` and `Key.direction` from the same `Keyset.Declaration` the memory `window` sorts by"

key-files:
  created:
    - packages/sql/src/KeysetSql.ts
    - packages/sql/test/KeysetSql.test.ts
  modified:
    - packages/sql/src/index.ts

key-decisions:
  - "Mixed-direction refusal is a `throw new Defects.InvalidConfiguration({ setting: \"keyset order\" })` at `KeysetSql.make`; a wrong cursor arity is `Defects.InvariantViolation` at `after`"
  - "`after` and `orderBy` take the client as an argument (`sql`), like `TenantScoped.predicate`, so a listing's module-level seek has no client dependency"

requirements-completed: []

duration: 15min
completed: 2026-11-14
status: complete
commits: 2
plan_head_before: e938de00314e4a4335c6e8a269dbd7dfb0dbb557
plan_head_after: ab2379ce8b1ae540c048a40c83d8a5ad061a2dae
---

# Phase 3 Plan 04: KeysetSql Summary

**`@awthaq/sql` gains `KeysetSql`: one row-value predicate `("c1", "c2") > (?, ?)` (or `<`) and one `ORDER BY` derived from the `Keyset.Declaration` a listing already declares, a mixed-direction declaration refused at `make`; no listing adopts it yet.**

KEY-03 is delivered here; it is not ticked by this plan (the orchestrator marks requirements at phase close). `requirements.mark-complete` was not run.

## KeysetSql API as built

```ts
interface Seek {
  readonly after: (sql: SqlClient.SqlClient, values: ReadonlyArray<unknown>) => Statement.Fragment;
  readonly orderBy: (sql: SqlClient.SqlClient) => Statement.Fragment;
}
make<Row, Cursor>(declaration: Keyset.Declaration<Row, Cursor>): Seek
```

- `after(sql, values)`: `("a", "b") > ($1, $2)` ascending, `<` descending; values are bound parameters, columns go through `sql(column)` escaping. A count different from the key count throws `Defects.InvariantViolation({ invariant: "keyset cursor arity" })`.
- `orderBy(sql)`: `"a" ASC, "b" ASC` or `... DESC` (one of two fixed keywords).
- `make` throws `Defects.InvalidConfiguration({ setting: "keyset order", message: "awthaq: ..." })` naming each `column direction` when directions differ.
- Barrel: `export * as KeysetSql from "./KeysetSql.ts";` after the `CoreStoresSql` line.
- Callers compose it as `sql.and([...tenant, ...filter, ...(cursor ? [seek.after(sql, values)] : [])])`; an empty list compiles to `1=1`, so the adapters' two-template branches can go (03-05..03-07).

## Accomplishments

- Tracer (Task 1): ascending `(at, id)` seek over a BIGINT/TEXT probe table with ties; for every cursor (none, each of 9 rows) and every take 1..10 the SQL page equals `Keyset.window`.
- Task 2 (9 tests in total): descending agreement, a three-key declaration agreeing with the window, composition inside `sql.and` next to a tenant equality and `"endedAt" IS NULL` (asc and desc, against pre-filtered window rows), `1=1` for an empty list, compiled shape per direction (`("at","id") > (P, P)`, `ORDER BY "at" ASC, "id" ASC`, no ` OR `, params equal the passed values), mixed-direction refusal by `_tag` and `setting`, arity refusal by `_tag` and `invariant`, and a `we"ird` column compiling to `"we""ird"` with an injection-shaped value left as a bound parameter.

## Task Commits

1. **Task 1: KeysetSql, barrel, ascending agreement** - `f39759f9` (feat)
2. **Task 2: full KeysetSql contract tests** - `ab2379ce` (test)

## Gate results

| Gate | Result |
|---|---|
| `npx tsc -b tsconfig.json`, `npx tsc -p tsconfig.test.json` | no `error TS` |
| `vitest run packages/sql/test/KeysetSql.test.ts` | 9 passed (SQLite) |
| Keyset.test + Wave 0 KeysetCursors / KeysetPins / KeysetHttp (unedited), with KeysetSql | 55 passed |
| `pnpm circular` | exit 0, no cycle |
| `pnpm check:error-tags` | `163 internal and 137 wire error tags, none shared` (baseline) |
| `pnpm lint` | no finding under packages/ (warnings only in `.claude/`, `features/`) |
| `pnpm format:check` | all matched files use the correct format |
| barrel line count | 1 |
| ports sources importing `@awthaq/sql` | 0 |
| `as` / `any` / `sql.unsafe` in KeysetSql.ts outside comments and imports | 0 |
| filtered knip check (3 readme-quickstart rows present) | 0 lines; no KeysetSql finding |

Postgres-gated cases: the same 9 tests run on Postgres under `AWTHAQ_POSTGRES_URL` in CI; not run locally (docker daemon down). Everything above ran on in-memory SQLite.

## Knip

No KeysetSql export or test file is flagged (namespace members of the sql entry are public to knip). The `<interfaces>` exports (`make`, `Seek`) stay; consumers arrive in 03-05..03-07, recheck at the 03-09 phase-close gate.

## Deviations from Plan

None - plan executed exactly as written. Minor build notes, not deviations: `sql(column)` is an `Identifier`, not a `Fragment`, so it is wrapped as `` sql`${sql(column)}` `` before `sql.csv`; the plan-head ledger file was not written (the linked worktree's git dir lives under the other checkout, as in 03-03), so `plan_head_before` is the start-of-run HEAD `e938de00` and `commits: 2` was measured with `git rev-list --count e938de00..HEAD`.

## Known Stubs

None.

## Threat Flags

None. T-03-07 (injection) is covered by the compiled-params, escaped-quote and `sql.unsafe` grep checks; T-03-08 (wrong page) by the two tagged refusals.

## Next Phase Readiness

03-05..03-07 can build a module-level `KeysetSql.make(declaration)` next to each listing's `Keyset.Declaration`, bind cursor values already encoded by their request schema, and replace hand-written `OR` expansions and ORDER BY strings with `seek.after` / `seek.orderBy`.

## Self-Check: PASSED

- FOUND: packages/sql/src/KeysetSql.ts, packages/sql/test/KeysetSql.test.ts
- FOUND commits f39759f9, ab2379ce (ancestors of HEAD)
