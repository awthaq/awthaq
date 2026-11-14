# Phase 3: Keyset-page module - Research

**Researched:** 2026-11-14
**Domain:** keyset (seek) pagination across a TypeScript/Effect v4 monorepo with memory and SQL (SQLite, libSQL, Postgres) store twins
**Confidence:** HIGH for in-repo inventory, golden values and blast radius (all read or executed this session); MEDIUM for Postgres collation behaviour (cannot run Postgres locally); two items `[ASSUMED]` (see Assumptions Log)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
CONTEXT.md has no `### Locked Decisions` heading; its `## Implementation Decisions` section is headed `### Claude's Discretion` and contains the already-decided constraints below. Copied verbatim:

> All implementation choices are at Claude's discretion: this is a structural refactor with technical success criteria and no new user-facing behaviour. The user's standing instruction for this milestone is the cleanest end state, not the simplest; complexity is accepted. The constraints below are already decided (REQUIREMENTS.md "Locked decisions", user-confirmed during milestone setup) and are not open:
>
> - Cursor wire format stays byte-identical per listing (`startedAt` for impersonations, `createdAt` for users and organizations); a golden test against today's three schemas proves it. No cursor wire change.
> - The store primitive owns `limit + 1`; `OrganizationRecords.listPage` and `AdminTenants` change in one commit so `+1` is applied exactly once. The post-page admin gate stays in the caller.
> - Postgres id ordering is declared collation-stable by construction, with a mixed-case `test:pg` case. No `COLLATE "C"` unless CI shows drift.
> - BEH-EA-036 wording is amended to scope "store ports" to core ports; Membership offset paging stays (KEY-F1 is a deferred follow-up).
> - A port-visible contract change ships with a changeset carrying a `Migration:` line (the Phase 1 routine).
> - Postgres is unavailable locally: SQL cases run in CI only; the phase records "not run locally" (GATE-04). Wave 0 records the gate baseline and a pin matrix of today's behaviour (limits, cursors, orders, tie handling) before any `src` change, as in Phases 1 and 2.
> - Strata: `api < ports < sql < core < server < qadi < plugins < cli/test/features`; the keyset module lives in `ports`, the predicate builder in `sql`, and `ports` must not import `sql`. `pnpm circular` counts type-only imports.
> - Research is recommended before planning (collation behaviour, the `limit + 1` contract, the sub-millisecond timestamp case); open design questions that research surfaces are resolved by the cleanest-end-state rule and recorded in the plans, and only a question that is genuinely the user's (a product or public-wire decision) is escalated.

### Claude's Discretion
Everything not listed above: module name and file, the shape of the module API, how mixed-direction orders are refused, how the golden test is built, test case design, plan decomposition. Standing rule: the cleanest end state, not the simplest.

### Deferred Ideas (OUT OF SCOPE)
- KEY-F1: convert `MembershipRecords` offset paging to keyset (a wire change; out of scope by decision).
- Also out of scope (REQUIREMENTS.md): opaque cursor tokens (KEY-F2), new dependencies or version bumps, replacing memory twins with SQLite `:memory:`, any cursor wire change.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| KEY-01 | Module in `@awthaq/ports` owns limit clamp (1..200, default 50), `limit + 1`, next-cursor derivation and the memory comparator derived from the declared order | Design Option C (`paginate` + declared `Order`), module sketch, 4 "has next" sites to collapse |
| KEY-02 | Users, organizations, impersonations adopt it with one page contract (store primitive owns `+1`; `OrganizationRecords.listPage` + `AdminTenants` in one commit) | Per-listing table, `+1` contract section, blast radius |
| KEY-03 | SQL row-value predicate builder in `@awthaq/sql` replaces the expanded-`OR` spellings, refuses mixed-direction orders | 2 OR-form sites + 1 row-value site; builder sketch; refusal mechanism |
| KEY-04 | Cursors byte-identical per listing, golden test | Golden values captured by running today's code; golden test form |
| KEY-05 | `StoreContract`/`RecordsContract` page-order cases (ties by id, exactly-full final page, sub-ms timestamps, mixed-case ids); `test:pg` in CI | Test inventory and gaps; collation + timestamp analysis |
| KEY-06 | Duplicate `pageLimit`/`listLimit`/`MAX_PAGE_SIZE` deleted (grep); post-page gate stays in caller | Clamp-copy inventory; scoped grep (webhooks survivor is intentional) |
| KEY-07 | Membership, `SessionStore.listLive`, SCIM, audit log, webhook deliveries untouched | Untouched-path list + empty-diff proof |
| KEY-08 | `spec/overview.md` `surface:ports` lists the module; BEH-EA-036 amended; collation declared | Spec work section (drift checks 13, 14, 17) |
| GATE-04 | Postgres verified in CI; "not run locally" recorded | CI wiring facts, Environment Availability |
</phase_requirements>

## Summary

There are exactly **three** keyset listings (users, organizations, impersonations), not "8+ sites". All three already return a domain page of `{items, nextCursor: Option<Cursor>}` (`Users.ts:375-379`, `ImpersonationRecords.ts:85-89`, and the org page built in `AdminTenants.ts:206-212`). The inconsistency is *below* the domain page: the users store returns `{items, next}` and owns `+1` in SQL; the organization store returns a bare array and its caller adds `+1`; the impersonation store owns `+1` in both adapters through `toPage`. There are 4 "has next" decision sites, 2 expanded-OR predicates, 1 row-value predicate, 3 hand-written memory comparators, and 2 source copies of the clamp (plus one cross-file import of it and the wire-schema bound).

The recommended design is a `Keyset` module in `packages/ports/src/Keyset.ts` whose centre is `paginate(order, fetch)`: it owns the clamp, computes `take = limit + 1`, trims, and derives `nextCursor` from the declared order's `cursorOf` accessor. Adapters supply only `fetch({after, take})`. `+1` is therefore applied exactly once structurally (not by convention), and the whole contract is unit-testable with a fake `fetch`. The memory comparator and the "row follows cursor" predicate are derived from the same declared order (a list of keys with direction and `Order`), so memory and SQL cannot disagree about the order by construction. A `KeysetSql` builder in `packages/sql/src` turns the same declaration into a row-value predicate plus `ORDER BY`, and refuses mixed-direction declarations when the builder is made.

The two real risks are not in the refactor mechanics. (1) A mixed-case id ordering case asserting exact code-unit order **will fail on CI's Debian `postgres:16` (glibc `en_US.utf8`)** while passing on the local alpine script (musl, C-like) and on SQLite; the locked decision ("declared collation-stable by construction, mixed-case `test:pg` case, no `COLLATE "C"` unless CI shows drift") must therefore be interpreted precisely: the mixed-case case asserts *self-consistency* (complete, duplicate-free, resumable at every page size) under the backend's own collation, and a separate canonical-uuidV7 case asserts exact code-unit parity everywhere. (2) Sub-millisecond timestamps cannot arise from app writers (JS `Date` is whole ms) but can from external writers; Postgres decode truncates to ms, which makes ASC listings repeat/loop and DESC listings skip. Declare ms precision by construction and test the premise.

**Primary recommendation:** Add `Keyset` (ports) = declared-order data + `paginate(order, fetch)` + derived memory comparator; add `KeysetSql` (sql) = row-value predicate + `ORDER BY` from the same declaration that dies on mixed direction; adopt it in users/impersonations/organizations (org store and `AdminTenants` in one commit); keep the three wire cursor schemas untouched; pin everything with a Wave 0 golden test and pin matrix before any `src` change.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Limit clamp (1..200, default 50), `limit + 1`, nextCursor derivation | `ports` (`Keyset`) | — | Pure, dependency-free helper; ports holds "port shapes and pure helpers" (CONTEXT.md Established Patterns) |
| Memory comparator and "follows cursor" predicate | `ports` (`Keyset`) | — | Derived from the declared order; used by memory twins in core/admin/organization (all above ports) |
| SQL row-value predicate and `ORDER BY` | `sql` (`KeysetSql`) | — | Needs `sql` fragments; `ports` must not import `sql` |
| Wire cursor schemas (3, `startedAt`/`createdAt`) | `admin` (api schemas) | — | Public wire; byte-identical, untouched |
| Wire `limit` bound (1..200) | `admin` (`LimitSchema`) | `ports` (constant) | Wire validation stays at the HTTP edge but references the module constant |
| Tenant visibility, `active` filter | listing store (`ImpersonationRecords`) | — | Part of the listing's filter, composes with the keyset predicate inside `sql.and` |
| Per-row visibility gate after paging (`gate.visibleEpisodes`) | `admin` (`Admin.list`) | — | KEY-06: stays in caller; a page may be short while `nextCursor` points onward |
| Collection-level gate before paging (`gate.collection`) | `admin` (`Admin.listUsers`, `AdminTenants.listOrganizations`) | — | Unchanged |

## Standard Stack

No new packages. Everything uses what is already installed. Recorded versions [VERIFIED: summary of repo reads this session, package.json files]:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| effect | 4.1.2 | `Order` (`make`, `mapInput`, `combine`, `flip`, `String`), `Option`, `DateTime` | Already the house stack; `Order` gives the derived comparator without hand-rolling |
| @effect/sql-pg | 4.1.2 | Postgres driver (own native protocol, not node-postgres) | Already in use; decodes `timestamptz` to ms `Date` |
| TypeScript (tsgo) | 7.0.2 | `tsc -b` | Repo toolchain; no compiler API (`typescript` exposes only `version`) |
| vitest + @effect/vitest | 5.0.2 | tests | Repo test runner |
| oxlint / oxfmt / knip / madge | repo pinned (knip 6.44.1) | gates | Repo gates |

### Supporting / Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `paginate(order, fetch)` (Shape C) | Data + free functions (Shape A) | A is smaller but leaves `+1` spread across adapters, repeating today's half-adoption failure mode |
| `paginate(order, fetch)` (Shape C) | Per-listing keyset object with methods (Shape B) | B duplicates the same logic three times |
| Hand-written comparators | `Order.combine`/`mapInput`/`flip` | Use Effect `Order`; do not hand-roll |

**Installation:** none. **Version verification:** versions above come from the workspace `package.json` files and the effect `dist` read this session; no registry install is performed (instruction: do not install anything).

## Package Legitimacy Audit

Not applicable: this phase installs no external packages (REQUIREMENTS.md Out of Scope: "New dependencies or version bumps"). No package name was discovered from non-authoritative sources. `@awthaq/ports` is already a dependency of `admin`, `organization`, `core` and `sql` [VERIFIED: package.json reads], so there is no new internal edge either.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
HTTP (admin api)                         in-process callers
  GET users / organizations / impersonations
  ?cursor=<base64url JSON>&limit=<1..200>          (limit?: number, cursor?: Cursor)
        |                                                  |
   wire schemas (admin, UNCHANGED):                        |
   Limit 1..200, cursor decode  --------->  domain method (Users.list / AdminTenants.listOrganizations / Admin.list)
                                                    |
                                  gate.collection(...)   (before paging, stays in caller)
                                                    |
                                  store.list*({after: Option<Cursor>, limit?: number})
                                                    |
                     +------------------------------+-------------------------------+
                     |  Keyset.paginate(order, fetch)  [ports]                      |
                     |   1. limit = Keyset.limit(requested)   (1..200, default 50)  |
                     |   2. rows  = fetch({after, take: limit + 1})   <-- ONLY +1   |
                     |   3. items = rows.slice(0, limit)                            |
                     |   4. nextCursor = rows.length > limit                        |
                     |        ? Some(order.cursorOf(last kept row)) : None          |
                     +--------------+---------------------------------+-------------+
                                    |                                 |
                    memory adapter fetch                    SQL adapter fetch
                    Keyset.window(order, rows,             KeysetSql (sql): row-value
                      {after, take})                        predicate + ORDER BY + LIMIT take
                    (comparator + follows derived          composed in sql.and([tenant, active,
                     from the SAME declared order)          keyset]) ; dialect-neutral
                                    |                                 |
                                    +----------------+----------------+
                                                     v
                                  Page { items, nextCursor: Option<Cursor> }
                                                     |
                  Admin.list only: gate.visibleEpisodes(items)   (post-page, stays in caller;
                                    a page may hold < limit rows while nextCursor points onward)
                                                     v
                              wire encode: base64url(JSON{<key>,id})  (byte-identical)
```

### Recommended Project Structure
```
packages/ports/src/
├── Keyset.ts              # NEW: MIN/MAX/DEFAULT limit, limit(), Page, key(), order, compare, follows, paginate, window
└── index.ts               # + export * as Keyset from "./Keyset.ts"   (31 `export * as` lines today)
packages/ports/test/
└── Keyset.test.ts         # NEW: unit tests with a fake fetch (clamp, +1 exactly once, cursor derivation, comparator)
packages/sql/src/
└── KeysetSql.ts           # NEW: row-value predicate + ORDER BY from the declared order; dies on mixed direction
packages/sql/test/
└── KeysetSql.test.ts      # NEW: SQLite fragment tests + mixed-direction refusal
```
Name `Keyset` (module) / `KeysetSql` (builder): matches the namespace-export convention of `index.ts` (`export * as AccountStore ...`). Open: `Keyset` vs `KeysetPage`; recommend `Keyset` (shorter, the module owns more than the page).

### Pattern 1: declared order as data, everything derived

**What:** one declaration per listing states the keys (accessor, direction, value `Order`, SQL column) and how to build the cursor from a row. The memory comparator, "follows cursor" and next-cursor derivation come from it; the SQL builder consumes the same declaration.

**Signature sketch (to be spiked; no `as`, no `any`, because oxlint `typescript/consistent-type-assertions: never` applies in `packages/*/src`):**
```typescript
// packages/ports/src/Keyset.ts  (sketch, not final)
import { Option, Order } from "effect";

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/** One rule for every listing: truncated, clamped 1..200, 50 when absent or non-finite. */
export const limit = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(Math.trunc(requested), MIN_LIMIT), MAX_LIMIT);

export interface Page<Item, Cursor> {
  readonly items: ReadonlyArray<Item>;
  /** `None` on the last page; an exactly-full final page does not invent a cursor. */
  readonly nextCursor: Option.Option<Cursor>;
}

export type Direction = "asc" | "desc";

/** One ordered key. Existential over the value type so keys of different types live in one tuple without `any`. */
export interface Key<Row, Cursor> { /* built only via key(...) ; hides V */ }
export declare const key: <Row, Cursor, V>(spec: {
  readonly column: string;            // SQL column, a fixed literal from the declaration, never caller input
  readonly direction: Direction;
  readonly order: Order.Order<V>;      // Order.String (code unit) for ids; DateTime.Order for timestamps
  readonly row: (row: Row) => V;
  readonly cursor: (cursor: Cursor) => V;
}) => Key<Row, Cursor>;

export interface KeysetOrder<Row, Cursor> {
  readonly keys: readonly [Key<Row, Cursor>, ...Array<Key<Row, Cursor>>];
  readonly cursorOf: (row: Row) => Cursor;   // keeps listing-specific field names (startedAt vs createdAt)
}

export declare const compare: <Row, Cursor>(o: KeysetOrder<Row, Cursor>) => Order.Order<Row>;
export declare const follows: <Row, Cursor>(o: KeysetOrder<Row, Cursor>, after: Cursor) => (row: Row) => boolean;

export declare const window: <Row, Cursor>(
  o: KeysetOrder<Row, Cursor>, rows: ReadonlyArray<Row>,
  req: { readonly after: Option.Option<Cursor>; readonly take: number },
) => ReadonlyArray<Row>;                      // memory helper: sort, filter after cursor, slice(0, take)

export declare const paginate: <Row, Cursor, E, R>(
  o: KeysetOrder<Row, Cursor>,
  req: { readonly after: Option.Option<Cursor>; readonly limit?: number | undefined },
  fetch: (r: { readonly after: Option.Option<Cursor>; readonly take: number }) => Effect.Effect<ReadonlyArray<Row>, E, R>,
) => Effect.Effect<Page<Row, Cursor>, E, R>;
```
**When to use:** every listing in KEY-02. **Source:** in-repo (shapes derived from `UserStore.ts:359-381`, `ImpersonationRecords.ts:196-219`, `OrganizationRecords.ts:211-232`) plus Effect `Order` [CITED: effect v4 `Order` module, read in `dist` this session].

### Pattern 2: SQL row-value predicate from the same declaration
```typescript
// packages/sql/src/KeysetSql.ts  (sketch)
// (col1, col2) > (v1, v2)   for uniform asc;  (col1, col2) < (v1, v2) for uniform desc;
// ORDER BY col1 ASC|DESC, col2 ASC|DESC. Direction comes from a closed union in the declaration, never input.
// Mixed directions have no row-value form: make(order) dies when keys disagree (declaration time).
export declare const make: <Row, Cursor>(order: KeysetOrder<Row, Cursor>) => {
  readonly after: (sql: SqlClient, cursor: Cursor) => Statement.Fragment; // composes inside sql.and([...])
  readonly orderBy: (sql: SqlClient) => Statement.Fragment;
};
```
Row-value comparison is valid in SQLite >= 3.15 and in Postgres; `OrganizationRecords.ts:424-426` already ships it, and `SessionStoreSql` (out of scope) already ships it on both dialects [VERIFIED: file reads this session]. Cursor values must be bound through the wire/dialect codecs already used per listing (`models.wire.nullableDateTime`, `SqlModels.dialectFields`), so Postgres gets a `Date` and SQLite gets the fixed-width ISO text. Verify in a spike that a row-value comparison binding a `Date` against `timestamptz` plans correctly (CI-only; see Open Questions).

### Anti-Patterns to Avoid
- **Half adoption of `+1`:** if any adapter still adds or trims, `+1` is applied twice or zero times. The structural fix is that only `paginate` computes `take`; adapters receive `take` and must return up to `take` rows.
- **Column-name indexing in the generic module:** `row[column]` needs `as` or `any`; use accessors (`row: (row) => V`).
- **A cursor-schema factory:** a computed generic key (`startedAt` vs `createdAt`) loses its literal type without `as` [ASSUMED, spike before committing]. Keep the three wire schemas in `admin` as they are.
- **Caller-supplied direction into SQL text:** direction is a closed union fixed in the declaration.
- **Importing `@awthaq/sql` from `ports`:** a wrong-direction edge; only `tsc -b` references and `pnpm circular` catch it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Multi-key comparator, descending order | per-listing `byCreation`/`newestFirst` | `Order.mapInput` + `Order.combine` + `Order.flip`, composed in `Keyset.compare` | Three hand-written comparators already exist (`UserStore.byCreation`, `newestFirst`, inline org sort) |
| Code-unit id comparison | custom `<` helpers (`codeUnit` in tests) | `Order.String` (`<`-based, code unit) | Same semantics as today, one definition |
| Row-value predicate | two expanded-OR copies | `KeysetSql` | OR form is the divergent spelling; row-value is the one already used for orgs and sessions |
| Limit clamp | `listLimit`, `pageLimit`, `LimitSchema` bounds | `Keyset.limit` + `MAX_LIMIT` constant | 2 source copies + 1 cross-file import + the wire bound |

**Key insight:** the bug class here is "two adapters or two callers each applied a rule once" (`+1`, the clamp, the order). Derive from one declaration; do not copy.

## Runtime State Inventory

Not a rename/migration phase. Brief explicit answers for completeness:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None: no schema, column or index change (cursor encoding unchanged) | none |
| Live service config | None | none |
| OS-registered state | None | none |
| Secrets/env vars | None | none |
| Build artifacts | `packages/*/lib` / dist output of changed packages is rebuilt by `tsc -b`; `tsc -b` must run before cross-package vitest (GATE-01) | rebuild |

## Per-Listing Inventory (item 1)

All paths relative to repo root. Facts verified by reading the files this session.

| | Users | Organizations | Impersonations |
|---|---|---|---|
| Sort key | `(createdAt, id)` ASC | `(createdAt, id)` ASC | `(startedAt, id)` DESC (ties: id DESC) |
| Cursor payload | `{createdAt: DateTime.Utc, id: string}` (`UserStore.ts:84-88`, `Users.ts:370-373`) | `{createdAt, id}` (`AdminTenants.ts:31-40`) | `{startedAt, id}` (`ImpersonationRecords.ts:80-83`) |
| Wire encoding | `base64url(JSON{createdAt,id})` (`AdminApi.ts` `UserCursorSchema`) | `base64url(JSON{createdAt,id})` (`AdminTenantsApi.ts:47-58`) | `base64url(JSON{startedAt,id})` (`AdminApi.ts` `CursorSchema`) |
| Limit default / max | 50 / 200 in `Users.listLimit` (`Users.ts:556-561`, `DEFAULT_LIST_LIMIT` at `:381`) | 50 / 200 via `ImpersonationRecords.pageLimit` (`AdminTenants.ts:199`, cross-file) | 50 / 200 in `ImpersonationRecords.pageLimit` (`:108-114`), applied inside both adapters |
| Who applies `+1` | the SQL adapter (`UserStoreSql.ts:187,191`); memory uses `following.length > limit` (`UserStore.ts:377`) | the **caller** (`AdminTenants.ts:202`, `limit: limit + 1`) | the store: `toPage` (`:209-219`); memory `rows.slice(0, limit+1)` (`:466`); SQL `LIMIT ${r.limit + 1}` (`:702`) |
| Who decides "has next" | store (`UserStore.ts:377`, `UserStoreSql.ts:486`) | caller (`AdminTenants.ts:207-210`) | store (`toPage`) |
| Store returns | `{items, next: Option<UserCursor>}` (`UserStore.ts:146-157`) | bare `ReadonlyArray<OrganizationRecord>` (`OrganizationRecords.ts:93-100`) | `ImpersonationPage {items, nextCursor}` |
| Memory adapter | `UserStore.layerMemory` (`UserStore.ts:359-381`); comparator `byCreation` (`:183-186`, no consumer outside `:362`) | `OrganizationRecords` memory (`:211-232`), inline sort/filter | `ImpersonationRecords` memory (`:457-466`); `newestFirst`/`isBeforeCursor` (`:196-205`) |
| SQL adapters | `UserStoreSql.ts` (OR-form `usersPage` `:176-192`; slice at `:473-492`) | `OrganizationRecords.ts:414-437` (row-value, `LIMIT ${r.limit}` no +1) | `ImpersonationRecords.ts:682-702` (OR-form) and `:768-784`; one `layerSql` serves both dialects via `SqlModels.dialectFields` |
| Caller gate | `Admin.listUsers`: `gate.collection` then `users.list(input)` (`Admin.ts:727-730`) | `gate.collection(caller, "listOrganizations")` (`AdminTenants.ts:198`) | `Admin.list` pages then `gate.visibleEpisodes` (post-page, `Admin.ts:983-991`) |
| Extra filters | none | tenant grant (`OrganizationRecords` `grant`) | `TenantScoped.visibility(grant)`, `"endedAt" IS NULL` when `active` |
| Public API reach | `@awthaq/ports` `UserStore.listPage` | `@awthaq/organization/records` subpath (`records.ts:26`), `OrganizationDirectory.listPage` (`:67-71`, `:218-219`; sole caller `AdminTenants`) | `@awthaq/admin` exports `pageLimit`, `DEFAULT_PAGE_SIZE` |

### Counts (corrected)
| Claim | Verified count |
|---|---|
| "8+ sites" | **3 listings**; 5 ancillary offset/other paging sites are out of scope (KEY-07) |
| `+1` sites | 4: `UserStoreSql.ts:187,191`, `AdminTenants.ts:202`, `ImpersonationRecords.ts:466` (memory), `:702` (SQL) |
| "has next" decision sites | 4: `UserStore.ts:377`, `UserStoreSql.ts:486`, `ImpersonationRecords.ts:209-219`, `AdminTenants.ts:207-210` |
| Expanded-OR predicates | 2: `UserStoreSql.ts:185-191`, `ImpersonationRecords.ts:696-701` |
| Row-value predicates in scope | 1: `OrganizationRecords.ts:424-426` (sessions also use one; out of scope) |
| Memory comparators | 3: `UserStore.byCreation`, `newestFirst`+`isBeforeCursor`, inline org sort/filter |
| Clamp copies | 2 source copies (`Users.ts:556-561`, `ImpersonationRecords.ts:108-114`), 1 cross-file import (`AdminTenants.ts:199`), 1 wire bound (`AdminApi.ts:160-163`, `MAX_PAGE_SIZE = 200`, `LimitSchema` isBetween 1..200) |
| Review citation corrections | `MembershipRecords.ts:212` is **offset** paging, not keyset; `SessionStore.ts:410` and `SessionStoreSql.ts:578` are `listLive` (`{items, truncated}`, no cursor): both out of scope |

## Golden Cursor Values (item 2)

Captured by running today's code (not by hand-deriving). Script: `/private/tmp/claude-502/-Users-mohammadalmechkor-Projects-Perso-awthaq/77238ac1-76b0-4bb3-a3a7-ec012e7983a4/scratchpad/golden-cursors.mjs`, output `golden-out.txt` in the same directory. Run twice: output deterministic; memory equals SQLite for all three listings. `T0 = 2026-03-01T00:00:00.000Z`. The `.mjs` is scratch-only and must not be committed (knip "Unused files"); the committed form is a vitest test file.

### Schema level (fixed objects, id `018f0000-0000-7000-8000-000000000002`, time `2026-03-01T00:00:00.002Z`)
- Users and organizations encode to `eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9`; decoded JSON `{"createdAt":"2026-03-01T00:00:00.002Z","id":"018f0000-0000-7000-8000-000000000002"}`.
- Impersonation encodes to `eyJzdGFydGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9`; decoded JSON `{"startedAt":"2026-03-01T00:00:00.002Z","id":"018f0000-0000-7000-8000-000000000002"}`.
- Equal to the independent derivation `Buffer.from(JSON.stringify({...})).toString("base64url")`: unpadded, length 112. JSON key order is the struct declaration order (`createdAt`/`startedAt` first, then `id`) and is part of the bytes.

### Users store (inserted out of order; id suffix @ offset ms): 1@0, 3@1, 2@1 (tie), 4@5, 5@5 (tie)
- limit 2: page `[1,2]` then next `eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMVoiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9` (`createdAt …00.001Z`, id `…0002`); page `[3,4]` then next `eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwNVoiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwNCJ9` (`createdAt …00.005Z`, id `…0004`); page `[5]` then none.
- limit 5: one page `[1..5]`, no cursor (exactly full). limit 4: `[1,2,3,4]` with the same `…005Z/…0004` cursor, then `[5]`.

### Impersonations (deterministic ids via seeded xorshift `SecureRandom.make` + `TestClock.setTime`), groups 3@+0, 1@+1, 3@+2, limit 3
- Creation ids: s-0-0 `019ca6b1-dc00-70bf-b9b8-eeb4d33cb85f`, s-0-1 `019ca6b1-dc00-70bf-b9b8-eeb5e174a69a`, s-0-2 `019ca6b1-dc00-70bf-b9b8-eeb676653da6`, s-1-0 `019ca6b1-dc01-7768-b7e5-29b894982ec0`, s-2-0 `019ca6b1-dc02-74bd-8bb7-c7c0872b7601`, s-2-1 `019ca6b1-dc02-74bd-8bb7-c7c11c090ff8`, s-2-2 `019ca6b1-dc02-74bd-8bb7-c7c2a935e055`.
- Pages (DESC; ties by id DESC): `[s-2-2, s-2-1, s-2-0]` then next `eyJzdGFydGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOWNhNmIxLWRjMDItNzRiZC04YmI3LWM3YzA4NzJiNzYwMSJ9` (`{"startedAt":"2026-03-01T00:00:00.002Z","id":"019ca6b1-dc02-74bd-8bb7-c7c0872b7601"}`); `[s-1-0, s-0-2, s-0-1]` then next `eyJzdGFydGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6IjAxOWNhNmIxLWRjMDAtNzBiZi1iOWI4LWVlYjVlMTc0YTY5YSJ9` (`startedAt …00.000Z`, id `019ca6b1-dc00-70bf-b9b8-eeb5e174a69a`); `[s-0-0]` then none.

### Organizations at records level (same seeded ids; slugs a,b,c@0; d@1; e,f,g@2; the caller asks `limit + 1 = 4` and trims)
- `[a,b,c]` (store returned 4 rows) then next `eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6IjAxOWNhNmIxLWRjMDAtNzBiZi1iOWI4LWVlYjY3NjY1M2RhNiJ9` (`createdAt …00.000Z`, id `…eeb676653da6`); `[d,e,f]` (4 rows) then next `eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOWNhNmIxLWRjMDItNzRiZC04YmI3LWM3YzExYzA5MGZmOCJ9` (`createdAt …00.002Z`, id `019ca6b1-dc02-74bd-8bb7-c7c11c090ff8`); `[g]` (1 row) then none.
- Real `AdminTenants.listOrganizations` through `TestAuth` (random ids): wire cursor equals the independent derivation; limit 5 over 5 orgs gives 5 items and no cursor; limit 4 gives 4 items and a cursor.

### Recommended golden test form
1. Fixed-object `encode` pins of the three wire schemas (the three literals above).
2. Store-level traversal using `SecureRandom.make(...)` for deterministic ids (users supply their own ids), asserting each page's cursor equals the pinned literal and equals `Buffer.from(JSON.stringify(...)).toString("base64url")`.
3. Run against memory and SQL twins so the golden also guards the adapters.

Wave 0 commits this against **today's** code; it must be green before and after every later plan (the golden is the KEY-04 proof).

## Test Inventory and Gaps (item 3)

### Existing tests that pin paging
| Where | What it pins |
|---|---|
| `packages/test/src/internal/storeContract/users.ts:505-534` | only users paging contract case: ids b, c (tie at minute 5), a (minute 9), z (minute 1), limit 3, plus exact-full limit 4. No mixed-case, no sub-ms |
| `packages/admin/test/contract/ImpersonationRecords.ts:447-570` | tie traversal across limit 1..8, normalised limit `[0,-3,2.5,NaN,10000]` giving `[1,true],[1,true],[2,true],[3,false],[3,false]`, exact-limit no cursor; uses a `codeUnit` helper |
| `packages/organization/test/contract/OrganizationRecords.ts:93-100, 285-340` | crossTenant `listPage` (uses `rows.some`: must become `page.items`), traversal asserting `Math.floor(7/limit)+1` pages (must become `ceil` under the page contract); `grant` and `codeUnit` helpers |
| `packages/admin/test/AdminTenants.test.ts:56-130` | domain-level limit sweep 1..8 over ties, limit normalisation, `first.nextCursor` |
| `packages/core/test/Users.test.ts` | paging ~255-290 (5 users, limit 2 then 3 pages; exact-full limit 5), clamp ~795-808 |
| `packages/admin/test/AdminUsers.test.ts:70-89` | users list |
| `packages/admin/test/AuthHttp.test.ts` | 277-316 impersonation list HTTP (`?limit=0`, `?limit=201` give 400); 410-426 users HTTP |
| `packages/sql/test/CoreStoresSql.test.ts:376-402` | ms/second rollover keyset order, uses `page.next` (`:394-397`); `ISO_FIXED_WIDTH` pin at `:240` |
| `packages/sql/test/UserStoreSql.test.ts:310` | store paging (uses `next`) |
| BDD `features/step-definitions/PersistenceMigrationSteps.ts:139-141, 234-238` (REQ-EA-093..095) | uses `first.next`, `second.next` |
| BDD `AdminSteps.ts:1020-1075`, `27-admin-impersonation.feature` REQ-EA-703..705 | impersonation paging |
| `features/step-definitions/PersistenceTypeGates.ts:9` | `@ts-expect-error` offset type gate `keyset-only-no-offset`: offset must stay a compile error |
| stubs touched by a signature change | `packages/organization/test/OrganizationConnections.test.ts:74` (`listPage: unused`), `features/step-definitions/TenancyWorld.ts:287` (`listPage: notUsedByTheStore`), `packages/core/test/Users.test.ts:827` |

### Gaps against KEY-05 and the pin matrix
- Nothing pins the **numeric** default 50 or max 200 (tests use at most 8 rows). Need 51 and 201 row cases.
- No mixed-case id case, no sub-millisecond case, anywhere.
- No users-store limit sweep across ties (impersonation and org have one).
- **No HTTP-level test for `/admin/organizations` and no cursor wire pin for the organization schema.**
- No store-level golden (see above).
- No test of a post-page gate short page with a non-None cursor beyond the impersonation contract (add a pin at the `Admin.list` level).

### Postgres wiring (item 3, CI only)
- `packages/test/src/StoreContract.ts` runs memory, sql and sealed modes. SQL runs: `StoreContract.sql.test.ts` (`TestSql.layer("store_contract")`: SQLite `:memory:` locally, Postgres when `AWTHAQ_POSTGRES_URL` is set), `.file` (SQLite WAL), `.libsql`, `.sealed`, `.memory`.
- `packages/test/src/RecordsContract.ts` runs every suite on memory and sql (SQLite `:memory:` or a Postgres schema); `sql` cases are SQL-mode only.
- `packages/test/src/TestSql.ts`: per-suite Postgres schema `t_<suite>_w<pool>`; `injectFailure`.
- **CI:** `.github/workflows/check.yml` uses a Postgres service image `postgres:16` (Debian) with `AWTHAQ_POSTGRES_URL=postgres://awthaq:awthaq@localhost:5432/awthaq_test`, node 22.22.0, and runs `pnpm check`. That includes `pnpm coverage` and `pnpm test:bdd` with the PG URL set, so Postgres cases run inside `pnpm check`, not via `pnpm test:pg` literally. The `changeset` job runs `changeset status` on PRs.
- **Local script:** `scripts/test-pg.sh` uses `postgres:16-alpine` (see collation).
- Cases that exist only to be verified on Postgres (CI): collation order of mixed-case ids; raw-insert microsecond row behaviour; the row-value predicate binding a `Date` to `timestamptz`; whole-ms stored precision.

## Collation and Timestamp Precision (item 4)

### Collation
- JS and the memory twins order ids by UTF-16 code unit (`Order.String` is `self < that ? -1 : 1` wrapped in `make`). SQLite uses BINARY. Postgres uses the **database default collation**.
- CI image `postgres:16` (Debian) sets `ENV LANG en_US.utf8`, so the DB collation is glibc `en_US.utf8` [CITED: docker-library/postgres 16 bookworm Dockerfile]. The local `postgres:16-alpine` image sorts bytewise/C-like because musl lacks `LC_COLLATE` [CITED via search: docker-library/postgres issues 327 and 1004]. **Alpine locally would hide drift CI will show.**
- Demonstrated by running JS: `["B1","a1","_x","A2","b0"]` sorts by code unit to `[A2,B1,_x,a1,b0]` but by `localeCompare("en-US")` to `[_x,a1,A2,b0,B1]` (script: `probe-dt.mjs` in the scratchpad). A mixed-case exact-order parity case **will** drift on CI's Debian Postgres [ASSUMED for the precise glibc ordering; high confidence it differs from code unit].
- Within one Postgres database, `ORDER BY id` and the row-value predicate use the same column collation, so paging stays self-consistent (complete, no duplicates, resumable) under **any** collation.
- Library-minted ids are lowercase hyphenated uuidV7 (`[0-9a-f-]`, fixed hyphen positions) from `random.uuidV7()` only [VERIFIED: `CreateInput` has no `id` field, `Users.ts:210-215`; `newUser` at `Users.ts:610-626`; Effect `SecureRandom` doc: "lowercase hyphenated string"]. These order identically under all sane collations. Mixed-case ids can only come from tests, direct SQL or custom writers.

### Recommended resolution (R1, consistent with the locked decision)
1. **Mixed-case case (KEY-05, runs everywhere):** assert self-consistency: traversal at every limit 1..N yields every id exactly once, no duplicates, resumable from any cursor. Do **not** assert exact code-unit order for foreign mixed-case ids.
2. **Canonical-uuid parity case (runs everywhere):** ids minted as lowercase uuidV7 must page in exact code-unit order on memory, SQLite and Postgres.
3. **Declare** "collation-stable by construction" in BEH-EA-036 and an ADR note: stable for library-minted ids and self-consistent for any id set.
4. **Fallback R2** (only if the user later wants exact byte order for foreign ids): `COLLATE "C"` on the id key. Cost: **no index migration for users and organizations** (there is no `(createdAt, id)` index on `users` or `organization_org`; only `users_email_unique`, `users_phone_unique`, `users_tenant_id` [VERIFIED: `CoreMigrations.ts:72-95`, `OrganizationMigrations.ts:45-68`]); **an index migration for impersonations** (`admin_impersonation_started_at ON ("startedAt", id)` at `Admin.ts:481-483` and `admin_impersonation_tenant_started_at ON ("tenantId","startedAt", id)` at `Admin.ts:605`). This corrects the prior `PITFALLS.md` claim. The audit-log and relay-cursor stores already use `COLLATE "C"` (`AuditLogStoreSql.ts:112-135`, `RelayCursorStoreSql.ts:47`); they are out of scope.

### Timestamps
- `@effect/sql-pg` 4.1.2 decodes `timestamptz` to a JS `Date` truncating to milliseconds (`PgTypes.ts:12-14, 1040-1046`: `new Date((micros - micros % 1000) / 1000 + PG_EPOCH_MS)`); encode is `Math.trunc(ms*1000)` microseconds [VERIFIED: `@effect/sql-pg` source read this session].
- JS `DateTime.Utc` has only `epochMilliseconds`; fractional numbers and microsecond strings truncate to integer ms (verified by running `probe-dt.mjs`). SQLite stores `createdAt` as fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ` text (`ISO_FIXED_WIDTH`, `CoreStoresSql.test.ts:240`).
- Therefore app writers can only produce whole-ms values. A row stored with sub-ms precision by an **external** writer would, on Postgres: repeat or loop in ASC listings (users, orgs: the row is `> cursor_ms`, so it reappears) and be skipped in DESC listings (impersonation). Cannot occur from app writers.
- `date_trunc` on `timestamptz` is probably STABLE (depends on session time zone), not IMMUTABLE, so an expression index is impractical [ASSUMED].
- **Recommendation:** declare whole-ms precision by construction (BEH-EA-036 + the module doc). Contract cases: two instants less than 1 ms apart (fractional-ms inputs truncate to the same ms) tie and order by id on every adapter; a `sql`-only case proving stored precision is whole ms; optionally a raw-insert microsecond case on Postgres documenting out-of-contract behaviour. Hardening against externally written microsecond rows is **not** recommended (cost > value; would need a column-type or expression-index change).

## The `limit + 1` Contract and Blast Radius (item 5)

**Contract to implement:** the store primitive owns `+1`. `Keyset.paginate` is the only code that computes `take = limit + 1`; a SQL adapter's `fetch` does `LIMIT ${take}`, a memory adapter's `fetch` does `Keyset.window(order, rows, {after, take})`. Callers never add or trim. `OrganizationRecords.listPage` becomes a page-returning store (`Page<OrganizationRecord, OrganizationCursor>`), `OrganizationDirectory.listPage` follows, and `AdminTenants.listOrganizations` just applies `gate.collection` then returns the page. These change in **one commit** (locked).

| Package | Public API change | Breaking? |
|---|---|---|
| `ports` | new `Keyset` namespace; `UserStore.listPage` page field `next` renamed `nextCursor` (recommended, to unify the page contract); `UserStore.byCreation` deleted (no outside consumer, verified `UserStore.ts:362` only) | additive + breaking (port shape) |
| `sql` | new `KeysetSql`; `UserStoreSql` internals | additive |
| `core` | `Users.listLimit` deleted; `UserCursor`/`UsersPage` become aliases of module types (names kept) | internal only |
| `admin` | `ImpersonationRecords.pageLimit` and `DEFAULT_PAGE_SIZE` removed; `AdminApi.MAX_PAGE_SIZE` removed or re-pointed at `Keyset.MAX_LIMIT`; `ImpersonationCursor`/`ImpersonationPage`/`OrganizationCursor`/`OrganizationPage` become aliases | **breaking** exports |
| `organization` | `OrganizationRecords.listPage` (public via `@awthaq/organization/records`) and `OrganizationDirectory.listPage` signatures change | **breaking** |
| `test` | StoreContract users suite and RecordsContract organization/impersonation suites gain/adjust cases | additive |
| `features` | `PersistenceMigrationSteps.ts` (`.next`), `TenancyWorld.ts:287` stub, `PersistenceTypeGates.ts` (offset must remain a compile error) | internal |

Test-file edits forced by the contract: `CoreStoresSql.test.ts:394-397`, `UserStoreSql.test.ts:310`, `Users.test.ts:827`, `OrganizationRecords` contract (crossTenant case; page-count formula), `OrganizationConnections.test.ts:74`. One changeset with a `Migration:` section naming ports, sql, admin, organization, core, test (single `fixed` group of 29 packages; CONTRIBUTING.md:104; example `.changeset/cli-plugin-views-config-list.md`).

**Caller enumeration (compile blast radius):** `ImpersonationRecords` is imported by `features/step-definitions/AdminWorld.ts`, `admin/src/{Admin,AdminApi,AdminEvents,AdminTenants,ImpersonationRecords,index,internal/AdminGate}.ts`, `admin/test/{Admin,AdminGate,Contract}.test.ts`, `admin/test/contract/ImpersonationRecords.ts`, `core/src/{AuditChain,AuditLog}.ts`, `jwt/src/SigningKeyRecords.ts`, `jwt/test/KeyRing.test.ts`, `organization/src/OrganizationRecords.ts` [VERIFIED: `rg` this session]. Most of these use the module for other things (grant, episode types); the ones that use `pageLimit`/`DEFAULT_PAGE_SIZE` must be found by a post-edit `tsc -b`, which is the authoritative blast-radius tool (tsgo has no compiler API for scripted analysis). `Users.list` callers: `Admin.ts:729`, `scim/src/Scim.ts:677` (`.listUsers(...)` on the SCIM side is a different method; confirm during execution).

## Design Options (item 6)

| Shape | Description | Verdict |
|---|---|---|
| A | declared `Order` data + free helpers (`limit`, `fetchSize`, `page`) | Reject as the end state: `+1` is applied by convention in each adapter |
| B | keyset object with methods per listing | Reject: triplicates logic |
| **C** | `paginate(order, fetch)` owns clamp, `take = limit + 1`, trim, nextCursor; adapters supply only `fetch` | **Recommend.** `+1` once by construction; fake-`fetch` unit tests cover the whole contract; builds on A's data |

Additional decisions (cleanest-end-state rule, internal, no escalation):
- **Cursor wire schema factory: no.** Keep the three wire schemas in `admin` untouched (byte-identical by construction); `LimitSchema` bounds reference `Keyset.MIN_LIMIT`/`MAX_LIMIT`. Request shapes legitimately differ (impersonation `active`/grant), so unify the response page and the mechanics, not the requests.
- **Clamp lives inside `Keyset.paginate`** (defence in depth, as `pageLimit` is today inside both impersonation adapters), so `Users.listLimit` and the `AdminTenants` clamp are deleted.
- **Delete `UserStore.byCreation`** (exported but only used at `UserStore.ts:362`); replace with the derived `Keyset.compare`.
- **Mixed-direction refusal:** `KeysetSql.make(order)` dies (defect) at construction when key directions differ, so a bad declaration fails on the first test run; add a unit test asserting the refusal. A type-level refusal would make the refusal untestable and is unnecessary because declarations are module-level constants. Verify the repo's lint/convention for throwing or `Effect.die` in pure builders during the spike.
- **Cursor field names** stay listing-specific through the explicit `cursorOf` accessor (`startedAt` vs `createdAt`), so no wire change.

## Spec Work (item 7)

- `spec/behaviors/05-persistence-stratum.md:97-114`: amend BEH-EA-036 to (a) scope "store ports" to core ports (Membership offset paging stays; cite KEY-F1), (b) state the page contract including who owns `limit + 1`, (c) declare id ordering collation-stable by construction (see R1) and whole-ms timestamp precision, (d) keep "Memory adapters compare ids by code unit, as SQL does" accurate for canonical ids. Bump Revision 1.13 to 1.14 and add the Change History row **together** (check 14: Revision equals newest Change History version, regex `(?:^|<br>|;)\s*(\d+\.\d+)\s*\(`).
- Also check BEH-EA-221 (`27-admin-impersonation.md:295-298`) and BEH-EA-222 (`:381-385`): "never more than `limit + 1` rows read" stays true; no change expected unless wording names `pageLimit`.
- `spec/overview.md:96-128`: add `Keyset` to the `surface:ports` alphabetical list (check 13: block equals the `export * as X` names in `packages/ports/src/index.ts`, currently 31). Row at `:154` for `UserStore` mentions `listPage`; update if the field rename is described. Bump Rev 1.17 to 1.18 with Change History.
- `spec/traceability.md` (Rev 1.90 to 1.91): rows at `:31` (05), `:186` (ADR-EA-041), `:236` (ImpersonationRecords contract), ADR-EA-004 row at `:149`; `features/traceability.md:113-115` (REQ-EA-093..095), `:644`, `:715-718`. Checks 4/4a/4b/15 govern REQ tags and generated `features/traceability.md`.
- **No new BEH is needed**, so the spec/README BEH range is not bumped (check 17). Adding one would force that bump; avoid.
- Consider an ADR-EA-041/004 revision note for the collation and whole-ms declarations.
- Current revisions [VERIFIED this session]: `05-persistence-stratum.md` Rev 1.13, `overview.md` Rev 1.17, `traceability.md` Rev 1.90.

## KEY-07: Untouched by Decision (item 8)

The phase diff must be empty over these paths. Proof: `git diff --stat <phase-base>..HEAD -- <paths>` returns nothing.

- Membership offset: `packages/organization/src/MembershipRecords.ts` (`:102, 206-216, 487-495, 641-643`), `Organization.ts:183`, `OrganizationHandlers.ts:242`, `OrganizationApi.ts:142-147`.
- `SessionStore.listLive`: `packages/ports/src/SessionStore.ts:404-410`; `packages/sql/src/SessionStoreSql.ts` (`PAGE = 200` ~`:64`, `Cursor` interface `:68-72`, row-value query ~`:185-206`, drain loop `:555-575`).
- SCIM: `packages/scim/src/Scim.ts` (`:246-248, 902-912, 1302-1329`), `ScimRecords.ts` (`:130-134, 395, 603-609, 748`).
- Audit log: `packages/ports/src/AuditLogStore.ts:74-82`, `packages/sql/src/AuditLogStoreSql.ts:112-135`, `RelayCursorStoreSql.ts:47`.
- Webhook deliveries: `packages/webhooks/src/WebhookRecords.ts:286`, `WebhooksApi.ts:138-146` (own `MAX_PAGE_SIZE = 200`), `Webhooks.ts:183` (`DEFAULT_PAGE = 50`) and `:760`.
- Other `byCreation` comparators (SessionStore, AccountStore, Scim, Saml, Webhook) are Phase 6 territory; do not touch.

**KEY-06 grep conflict:** a repo-wide grep for `MAX_PAGE_SIZE` hits the surviving `packages/webhooks/src/WebhooksApi.ts:138,146` (and `Webhooks.ts:183` `DEFAULT_PAGE`). The plan must **scope** the grep to `packages/{core,admin,organization,ports,sql}/src` and record the webhooks survivor as intentional (KEY-07), otherwise KEY-06 and KEY-07 contradict each other.

## Common Pitfalls

### Pitfall 1: a mixed-case exact-order case fails on CI only
**What goes wrong:** passes locally (SQLite, alpine PG) and on memory, fails on Debian `postgres:16` (en_US.utf8).
**Why:** collation difference (see above). **Avoid:** R1 (self-consistency for mixed-case, exact parity only for canonical uuid). **Warning:** a CI-only red in `StoreContract`/`RecordsContract` postgres run.

### Pitfall 2: half-adopted `+1`
Org store and `AdminTenants` must change in one commit; otherwise the page holds `limit - 1` items or an off-by-one cursor. The organization contract's page-count formula changes from `floor(7/limit)+1` to `ceil(7/limit)` (an exactly-full final page no longer yields a phantom empty page).

### Pitfall 3: cursor bytes drift
JSON key order and DateTime formatting are part of the wire bytes. Do not route cursors through a new codec; keep the three schemas. Golden test first (Wave 0).

### Pitfall 4: post-page gate vs short page
`Admin.list` gates **after** paging, so a page can hold fewer than `limit` rows while `nextCursor` points onward (`Admin.ts:983-991`). Do not "fix" this into the store (KEY-06 says it stays in the caller). Pin it in Wave 0.

### Pitfall 5: knip and the gates
- A committed `.cjs`/`.mjs` helper is an "Unused files" regression (knip config ignores `.scratch/**`, not `scripts` helpers). Golden/pin work is a vitest file.
- Removed exports (`pageLimit`, `DEFAULT_PAGE_SIZE`, `listLimit`, `byCreation`) must have no stale re-exports; new `Keyset` helpers must all be used or knip flags them.
- knip baseline: exit 1 pre-existing (39 `.claude/` files + 3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`); compare with the filtered form.

### Pitfall 6: no type assertions
`typescript/consistent-type-assertions: never` in `packages/*/src` (`as const` allowed). The generic module must use accessor functions and an existential `key(...)`, not `row[column] as V`.

### Pitfall 7: declaration emit (TS2883)
New exported generics returning types built from non-exported or non-nameable types can fail declaration emit under `tsc -b`. Annotate exported return types explicitly; run `tsc -b` per plan.

### Pitfall 8: formatting and filesystem
New files need `oxfmt` (`pnpm format:check`); macOS is case-insensitive, so check path-case in imports (`Keyset.ts` vs `keyset.ts`) against `git ls-files`, not `ls`.

### Pitfall 9: strata
`ports` must not import `sql`; `pnpm circular` counts type-only imports. Only `tsc -b` references catch a wrong-direction edge. No new internal dependency edge is needed (admin, organization, core, sql already depend on `@awthaq/ports`).

### Pitfall 10: flaky or slow tests
`StoreContract.test.ts` sql-mode case can hit the 5000 ms default timeout under load; the passkey `ChallengeStore` test is a known intermittent. Re-run in isolation before treating as a regression; do not "fix" by editing unrelated tests.

### Pitfall 11: Postgres availability
Local `docker` CLI is installed (`/opt/homebrew/bin/docker`, v29.1.3) but the daemon is not running (`docker info` fails). Earlier research notes claiming docker "is not installed" are wrong in the first half; the outcome (Postgres unavailable locally) is the same. Record "not run locally".

## Code Examples

### Pinned wire encode (golden, Wave 0)
```typescript
// Source: golden-cursors.mjs run against today's code (this session); decode literal pinned independently
const expected = Buffer.from(
  JSON.stringify({ createdAt: "2026-03-01T00:00:00.002Z", id: "018f0000-0000-7000-8000-000000000002" }),
).toString("base64url");
// === "eyJjcmVhdGVkQXQiOiIyMDI2LTAzLTAxVDAwOjAwOjAwLjAwMloiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiJ9"
```

### paginate (shape of the one place `+1` lives)
```typescript
// Sketch: derived from UserStore.ts:359-381 / ImpersonationRecords.ts:208-219; the only +1 in the codebase after the phase
const paginate = (order, req, fetch) =>
  Effect.gen(function* () {
    const size = limit(req.limit);
    const rows = yield* fetch({ after: req.after, take: size + 1 });
    const items = rows.slice(0, size);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > size && last !== undefined ? Option.some(order.cursorOf(last)) : Option.none(),
    };
  });
```

### Row-value spelling to replace the OR form
```sql
-- today (UserStoreSql.ts:185-191): "createdAt" > c OR ("createdAt" = c AND id > i)
-- after (as OrganizationRecords.ts:424-426 already does): ("createdAt", id) > (c, i)
-- impersonation DESC: ("startedAt", id) < (c, i)   ORDER BY "startedAt" DESC, id DESC
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Expanded-OR keyset predicate | Row-value `(a,b) > (x,y)` | One spelling; valid in SQLite >= 3.15 and Postgres; requires uniform direction (hence "refuses mixed") |
| Per-adapter `+1` and trim | one `paginate` | `+1` applied once structurally |

**Deprecated/outdated:** `ImpersonationRecords.pageLimit`/`DEFAULT_PAGE_SIZE`, `Users.listLimit`, `UserStore.byCreation` (all removed by this phase).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A computed generic cursor key (`startedAt` vs `createdAt`) loses its literal type without `as`, so a cursor-schema factory is not viable | Anti-Patterns / Design Options | Low: factory is optional; if viable it could remove ~2 schemas, but it would risk the byte-identical wire |
| A2 | `date_trunc` on `timestamptz` is STABLE, not IMMUTABLE, so an expression index is impractical | Collation and Timestamp | Low: only affects a rejected hardening option |
| A3 | Debian `postgres:16` glibc `en_US.utf8` orders `["B1","a1","_x","A2","b0"]` like en-US `localeCompare` (`[_x,a1,A2,b0,B1]`) rather than code unit | Collation | Medium: if CI happens to equal code unit, R1's self-consistency case still passes; only the "will drift" prediction is wrong |
| A4 | Row-value comparison binding a `Date` against `timestamptz` plans and returns correctly via `@effect/sql-pg` | Pattern 2 | Medium: first proven on CI (Postgres unavailable locally); the org store already ships a row-value predicate so the risk is limited to the `Date` bind |
| A5 | `KeysetSql.make` dying (defect) at construction fits the repo's lint/error conventions | Design Options | Low: fall back to returning a typed error or a branded builder |

## Open Questions

1. **Does CI's Debian Postgres actually reorder mixed-case ids?**
   - Known: image locale is `en_US.utf8`; alpine is C-like. Not runnable here.
   - Unclear: exact observed order.
   - Recommendation: R1 makes the answer irrelevant to pass/fail; the first CI run records the observed order in the plan summary. Escalate to R2 (`COLLATE "C"`) only if the user wants exact byte order for foreign ids.
2. **Module name and file (`Keyset` vs `KeysetPage`).** Recommend `Keyset.ts`, namespace `Keyset`.
3. **Rename `UserStore` page field `next` to `nextCursor`?** Recommend yes (one page contract, KEY-02); it is a port-shape break covered by the single `Migration:` changeset.
4. **Should `Keyset.limit` clamp live only in `paginate`, or also be exported for `LimitSchema`?** Recommend export constants only (`MIN_LIMIT`, `MAX_LIMIT`, `DEFAULT_LIMIT`) and the `limit` function; `LimitSchema` references the constants.
5. **Whole-ms precision as a stated contract vs hardening against microsecond external writers.** Recommend declare, do not harden (see timestamps). This interprets the locked collation decision in the same "by construction" spirit; flag to the user as an FYI, not a blocker.

No question is genuinely the user's (no product or public-wire decision): the cursor wire is locked byte-identical.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | all gates | yes | v26.13.0 (CI uses 22.22.0) | — |
| pnpm | all gates | yes | 11.20.0 | — |
| docker CLI | local Postgres via `scripts/test-pg.sh` | CLI yes, **daemon no** | 29.1.3 | CI `postgres:16` service; record "not run locally" |
| Postgres (local) | KEY-05/GATE-04 SQL cases on PG | **no** | — | CI only |
| SQLite / libSQL | local SQL contract runs | yes (bundled in the test layers) | — | — |
| pglite | alternative local PG | no (not a dependency; adding one is out of scope) | — | — |

**Missing with no fallback:** none that block execution; Postgres-only cases cannot be confirmed locally.
**Missing with fallback:** Postgres: CI-only; record "not run locally" in the phase close (GATE-04).

## Validation Architecture

`.planning/config.json` has no `workflow.nyquist_validation` key, so this section is enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5.0.2 + `@effect/vitest`; Cucumber BDD (`pnpm test:bdd`) |
| Config file | workspace vitest configs (existing); none new |
| Quick run command | `pnpm tsc -b && pnpm vitest run <file>` (cross-package tests need `tsc -b` first) |
| Full suite command | `pnpm check` (CI) / local gate list below |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| KEY-01 | clamp (1..200, default 50, non-finite, fractional), `take = limit + 1` once, nextCursor derivation, derived comparator | unit (fake `fetch`) | `pnpm vitest run packages/ports/test/Keyset.test.ts` | Wave 0 gap (new file) |
| KEY-02 | users/orgs/impersonations one page contract; limit sweep over ties; exactly-full page; numeric 50/200 with 51/201 rows | contract + domain | `pnpm vitest run packages/test/src/StoreContract.*.test.ts packages/admin/test/AdminTenants.test.ts packages/core/test/Users.test.ts` | partial; add cases |
| KEY-03 | row-value fragment per listing (asc/desc), `ORDER BY`, composes with tenant/active predicates; mixed direction refused | unit (SQLite) | `pnpm vitest run packages/sql/test/KeysetSql.test.ts` | Wave 0 gap (new file) |
| KEY-04 | cursor bytes equal pinned literals for all 3 listings, memory and SQL | golden | `pnpm vitest run packages/admin/test/KeysetGolden.test.ts` (exact location is the planner's call) | Wave 0 gap (new file) |
| KEY-05 | ties by id, exactly-full final page, sub-ms timestamps, mixed-case ids (self-consistency), canonical-uuid parity | contract (memory, SQLite, WAL, libSQL, sealed; Postgres in CI) | `pnpm vitest run packages/test/src/StoreContract.sql.test.ts` / `RecordsContract` suites; PG: CI `pnpm check` | extend existing files |
| KEY-06 | duplicates gone; post-page gate stays | grep + pin | `rg -n 'pageLimit\|listLimit\|MAX_PAGE_SIZE\|DEFAULT_PAGE_SIZE' packages/{core,admin,organization,ports,sql}/src` expects only `Keyset` definitions and the wire `LimitSchema` reference | n/a |
| KEY-07 | untouched | diff | `git diff --stat <phase-base>..HEAD -- <KEY-07 paths>` empty | n/a |
| KEY-08 | surface:ports lists module; BEH-EA-036 amended; collation declared | spec drift | `pnpm spec:verify:strict` | existing |
| GATE-04 | Postgres in CI, "not run locally" | CI + record | CI run of `pnpm check` with `AWTHAQ_POSTGRES_URL` | CI only |

### Sampling Rate
- **Per task commit:** `pnpm tsc -b` plus the touched package's vitest files.
- **Per wave merge:** `pnpm tsc -b`, `pnpm tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm lint`, targeted vitest of ports/sql/core/admin/organization/test.
- **Phase gate:** full gate list green against the baseline before `/gsd-verify-work`.

### Gate list (Wave 0 re-records the baseline at current HEAD; Phase 2 close numbers shown only as reference)
`tsc -b`, `tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm check:error-tags`, `pnpm check:transactions`, `pnpm check:contract-tests`, `pnpm lint`, `pnpm format:check`, `pnpm check:readmes`, `pnpm workspace:check`, `pnpm test:bdd`, `pnpm test`, `pnpm coverage`, `pnpm spec:verify:strict`, `pnpm knip` (filtered form), `package:smoke`, `test:pg` (CI only).

| Gate | Phase 2 close reference |
|---|---|
| `pnpm test` | 411 files + 4 skipped, 6491 passed, 1 expected fail, 15 skipped |
| `pnpm test:bdd` | 39 files, 1576 passed, 44 skipped |
| coverage | 91.65 / 85.08 / 86.91 / 92.17 (floors 89 / 83 / 84 / 90) |
| `check:error-tags` | 163 internal, 137 wire |
| `check:contract-tests` | 21 plugin classes |
| spec | PASS 32 |
| knip | exit 1 pre-existing (39 `.claude/` files + 3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`); filtered form drops `.claude/` and `.reports/` |

New tests add to these counts; the phase compares to the **Wave 0 re-record**, not these reference numbers.

### Wave 0 Gaps
- [ ] `packages/ports/test/Keyset.test.ts`: KEY-01 (written with the module in the ports plan; Wave 0 records the pin matrix only)
- [ ] Golden test file (KEY-04) pinned to today's code, **committed before any `src` change**
- [ ] Pin matrix tests against today's behaviour: numeric default 50 / max 200 (51 / 201 rows), tie order, exactly-full page, clamp list `[0,-3,2.5,NaN,10000]`, tenant/active filter, post-page gate short page with non-None cursor, **org HTTP wire cursor** (`/admin/organizations`, new)
- [ ] Wave 0 pins target **stable domain-level behaviour** (`Users.list`, `AdminTenants.listOrganizations`, `Admin.list`, HTTP), not `OrganizationRecords.listPage` raw shapes, which are about to change
- [ ] Gate baseline re-recorded at HEAD (`02-BASELINE.md` is the template), including `check:contract-tests`, `package:smoke`, and "test:pg not run locally"

## Security Domain

`security_enforcement` is not set in `.planning/config.json`: enabled.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | unchanged |
| V3 Session Management | no | unchanged |
| V4 Access Control | yes (preserved) | `gate.collection` before paging, `gate.visibleEpisodes` after, `TenantScoped.visibility`; must be unchanged |
| V5 Input Validation | yes | wire `LimitSchema` (int, 1..200) and cursor schema decode at the HTTP edge; `Keyset.limit` as defence in depth; tampered/undecodable cursor yields 400 (pin) |
| V6 Cryptography | no | cursors are not signed (KEY-F2 deferred); no change |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via cursor values or direction | Tampering | cursor values bound as parameters through existing codecs; direction and column names come only from the closed declaration; never from caller input |
| Cross-tenant listing via cursor reuse | Information disclosure | tenant predicate stays in `sql.and` alongside the keyset predicate; add a pin that a cursor from tenant A cannot reveal tenant B rows (the impersonation and org crossTenant cases exist; keep them) |
| Unbounded read (limit abuse) | DoS | clamp in the module (max 200) plus wire bound; `limit + 1` never exceeds 201 rows |
| Tampered cursor with oversized or malformed fields | Tampering | existing wire schema decode; unchanged |

## Recommended Plan Decomposition (item 10)

Sequence is dependency-ordered; each plan ends with `tsc -b` and its gates against the Wave 0 baseline.

0. **Wave 0 (plan 03-01): baseline, golden, pin matrix.** Re-record the gate baseline at HEAD (mirror `02-BASELINE.md`); commit the golden test and the pin matrix against today's code; no `src` change. Record the KEY-06 grep baseline and the KEY-07 path list; record `test:pg` as "not run locally".
1. **Ports module (03-02):** `Keyset.ts` + `index.ts` export + `Keyset.test.ts` (fake-fetch: clamp, `+1` once, exactly-full, cursor derivation, comparator ties/desc). No consumer yet; knip needs a consumer, so land plans 1 and 2 in the same wave or have the module exercised by its own test and consumed in plan 3 before the knip gate runs (planner decides; knip gate evaluated at phase close).
2. **SQL builder (03-03):** `KeysetSql.ts` + tests (asc, desc, composes in `sql.and`, mixed-direction refusal).
3. **Adopt: users + impersonations (03-04):** `UserStore` (rename `next` to `nextCursor`, delete `byCreation`, memory via `window`), `UserStoreSql`, `Users` (delete `listLimit`, aliases), `ImpersonationRecords` (delete `pageLimit`/`DEFAULT_PAGE_SIZE`, memory + SQL via module); update stubs and tests (`CoreStoresSql.test.ts`, `UserStoreSql.test.ts`, `Users.test.ts`).
4. **Adopt: organizations (03-05), single commit:** `OrganizationRecords.listPage` to a page, `OrganizationDirectory.listPage`, `AdminTenants.listOrganizations`, `OrganizationRecords` contract (`page.items`, `ceil` page count), `OrganizationConnections.test.ts` stub, `TenancyWorld.ts` stub.
5. **Contract + BDD cases (03-06):** `StoreContract` users suite (sweep, mixed-case self-consistency, canonical parity, sub-ms ties, numeric 50/200), `RecordsContract` org/impersonation suites, `PersistenceMigrationSteps.ts` (`.next` to `.nextCursor`), `AdminApi` `LimitSchema` bound references `Keyset` constants.
6. **Cleanup + grep (03-07):** delete remaining duplicates; scoped KEY-06 grep; KEY-07 empty-diff proof.
7. **Spec + changeset (03-08):** BEH-EA-036 amendment, `surface:ports`, Revision bumps with Change History (05 to 1.14, overview to 1.18, traceability to 1.91), traceability rows, one changeset with `Migration:` (ports, sql, admin, organization, core, test).
8. **Phase close (03-09):** full gate list vs Wave 0 baseline; CI Postgres run for GATE-04 (record "not run locally"); record observed CI collation order.

Plans 03-04 and 03-05 can be parallel only if they do not both touch shared test helpers; planner to check.

## Sources

### Primary (HIGH confidence)
- Repo files read this session (paths and line ranges cited inline): `packages/ports/src/UserStore.ts`, `packages/sql/src/UserStoreSql.ts`, `packages/core/src/Users.ts`, `packages/admin/src/{ImpersonationRecords,AdminTenants,Admin,AdminApi,AdminTenantsApi}.ts`, `packages/organization/src/{OrganizationRecords,OrganizationDirectory}.ts`, migrations, contract and test files, `spec/` files, `.github/workflows/check.yml`, `scripts/test-pg.sh`.
- Golden values: executed against today's code (scratchpad `golden-cursors.mjs` and `golden-out.txt`).
- `@effect/sql-pg` 4.1.2 source: `PgTypes.ts:12-14, 1040-1046` (timestamp decode and encode).
- effect 4.1.2 `dist` (`Order`, `DateTime`, `Schema`, `SecureRandom`) read this session; `probe-dt.mjs` executed.

### Secondary (MEDIUM confidence)
- docker-library/postgres Dockerfile (`LANG en_US.utf8`) and issues 327/1004 (alpine collation), via web search.

### Tertiary (LOW confidence)
- `date_trunc` volatility (A2); glibc ordering prediction (A3). Flagged `[ASSUMED]`.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new packages; versions read from the workspace.
- Architecture: HIGH for inventory and blast radius; MEDIUM for the exact module type signatures (spike items: existential `Key`, builder refusal mechanism).
- Pitfalls: HIGH for repo-specific; MEDIUM for Postgres collation (cannot run Postgres locally).

**Research date:** 2026-11-14
**Valid until:** 2026-12-14 (stable domain; re-verify if `main` changes the three listings or `check.yml`)
