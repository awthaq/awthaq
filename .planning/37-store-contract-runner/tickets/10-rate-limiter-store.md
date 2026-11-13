---
plan: 37-store-contract-runner
ticket: 10
title: RateLimiterStore joins the contract
type: tdd
wave: 7
depends_on: [09, 02]
files_modified:
  - packages/test/src/internal/storeContract/rateLimiterStore.ts
  - packages/test/src/StoreContract.ts
  - packages/test/test/StoreContract.test.ts
  - packages/sql/test/RateLimiterStoreSql.test.ts
  - packages/sql/test/RateLimiterStoreSql.postgres.test.ts
autonomous: true
requirements: [REQ-EA-1585]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "A RateLimiterStore whose increment reads (peek) then writes fails the rateLimiterStore race case"
    - "StoreContract.rateLimiterStore runs on RateLimiter.layerStoreMemory and on RateLimiterStoreSql.layerStoreSql over SQLite, a WAL file, libSQL and (under test:pg and CI) a Postgres TestSql schema"
    - "8 concurrent increments of one key return counts 1..8 on every adapter"
    - "The memory coverage check counts RateLimiterStore among the bundle's ports"
    - "packages/sql/test/RateLimiterStoreSql.test.ts and RateLimiterStoreSql.postgres.test.ts no longer exist"
  artifacts:
    - path: "packages/test/src/internal/storeContract/rateLimiterStore.ts"
      provides: "rateLimiterStore = suite(RateLimiter.RateLimiterStore, { operations: { increment, peek }, sql: [sweeper, missing table] })"
  key_links:
    - from: "packages/test/src/StoreContract.ts"
      to: "packages/sql/src/RateLimiterStoreSql.ts"
      via: "SQL base runs RateLimiterStoreSql.migrate; bundle merges RateLimiterStoreSql.layerStoreSql"
      pattern: "RateLimiterStoreSql\\.(migrate|layerStoreSql)"
    - from: "packages/test/src/StoreContract.ts"
      to: "packages/ports/src/RateLimiter.ts"
      via: "memory bundle merges RateLimiter.layerStoreMemory"
      pattern: "RateLimiter\\.layerStoreMemory"
---
Status: done (uncommitted)
Blocked by: 09, 02

<objective>
`RateLimiterStore` (`packages/ports/src/RateLimiter.ts:114-125`) has two adapters and no contract. Its SQL tests hand-wire SQLite (`packages/sql/test/RateLimiterStoreSql.test.ts:14`, 8 cases) and Postgres (`RateLimiterStoreSql.postgres.test.ts`, 1 case). The Postgres one drops `rate_limit_buckets` and its ledger in the connection's default schema, outside `TestSql`. The memory adapter is never raced. Plan 02 called this port the precedent for the core store seam (`.planning/02-domain-store-seam/PLAN.md:1255`).

Purpose: the seventh suite. A non-atomic store is caught, and every case runs on Postgres in its own schema.

Output: the suite, the runner wiring, a mutant test, and the two SQL test files deleted (replace, don't layer).
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§2.2 F8-F10, §3.3, §3.6 last row, §5.2)
@packages/ports/src/RateLimiter.ts (lines 108-130 the port; 280-350 the memory store)
@packages/sql/src/RateLimiterStoreSql.ts (migrations, migrate, layerStoreSql)
@packages/sql/test/RateLimiterStoreSql.test.ts
@packages/sql/test/RateLimiterStoreSql.postgres.test.ts
@packages/test/src/StoreContract.ts (run from ticket 09)
@packages/ports/test/RateLimiter.test.ts (what stays: limiter-level and memory-only sweeper/eviction cases)
</context>

<tasks>
  <task type="tdd">
    <name>Task 1 (RED): a read-then-write store is not caught</name>
    <files>packages/test/test/StoreContract.test.ts</files>
    <read_first>packages/test/test/StoreContract.test.ts (the no-op give-back mutant from ticket 01, now on runSuite)</read_first>
    <behavior>
      - "a RateLimiterStore whose increment reads then writes fails the race case": a mutant layer over RateLimiter.layerStoreMemory whose increment is peek, then Effect.yieldNow(), then the real increment. Report the count as the peeked count plus 1, or 1 when peek is None. That is the check-then-act race BEH-EA-105 rules out. runSuite over StoreContract.rateLimiterStore with this layer (runSuite provides the TestClock). Assert at least one failed name contains "increment [race]".
    </behavior>
    <action>Write the test with no type assertion. Build the mutant as the give-back mutant is built: read the real store from the layer and return RateLimiter.RateLimiterStore.of with increment overridden. It fails now: StoreContract.rateLimiterStore does not exist.</action>
    <verify><automated>! pnpm exec vitest run packages/test/test/StoreContract.test.ts   # RED until Task 2</automated></verify>
    <acceptance_criteria>The test fails for the missing suite.</acceptance_criteria>
    <done>The gap is a red test.</done>
  </task>

  <task type="tdd">
    <name>Task 2 (GREEN): the suite and its wiring in run</name>
    <files>packages/test/src/internal/storeContract/rateLimiterStore.ts, packages/test/src/StoreContract.ts</files>
    <read_first>packages/sql/test/RateLimiterStoreSql.test.ts (every case); packages/ports/src/RateLimiter.ts lines 108-130 and 300-345</read_first>
    <behavior>
      - increment [atomic]: "the first increment of a key is count 1, reset at now plus the window"; "different keys are independent buckets"; "once the window has elapsed the next increment is count 1 with a later resetAt" (TestClock.adjust by the window).
      - increment [race]: "8 concurrent increments of one key return counts 1..8" (race over increment, sorted counts deepStrictEqual 1..CONCURRENCY).
      - peek [read]: "peek is None for an absent key, reads a live bucket without advancing it, and is None once its window has elapsed" (live means now is before resetAt on both adapters; at exactly resetAt it is None).
      - sql: "the sweeper deletes expired rows" (increment, TestClock.adjust 61 s, SELECT bucket_key FROM rate_limit_buckets is empty); "a missing table surfaces as RateLimiterStoreUnavailable, not a defect" (DROP TABLE rate_limit_buckets, then increment flips to RateLimiterStoreUnavailable).
    </behavior>
    <action>Create rateLimiterStore.ts with a header citing BEH-EA-105/109, RBS-004/009 and plan 37, and the suite above, with cases ported from RateLimiterStoreSql.test.ts. Use a 10-second window as that file does. Cases use TestClock.adjust, which run provides (ticket 09). Re-export it from StoreContract.ts, add rateLimiterStore to Suites and suites, and update run. In memory mode the per-case bundle becomes the merge of Persistence.memory and RateLimiter.layerStoreMemory. The coverage test also takes the keys of a built RateLimiter.layerStoreMemory, minus RateLimiter.RateLimiterMemoryStats' key. In SQL mode the base also runs RateLimiterStoreSql.migrate after the core migrations: it uses its own ledger table, so the ids do not collide. The bundle merges RateLimiterStoreSql.layerStoreSql. Sealed mode is unchanged. Update run's doc comment.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.test.ts packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts</automated></verify>
    <acceptance_criteria>The mutant test passes. The memory run shows "StoreContract: RateLimiterStore (Ref)" with 5 entries; the three SQL runs show 7 (5 entries and 2 sql). `grep -c 'rateLimiterStore' packages/test/src/StoreContract.ts` is at least 2 (baseline 0). If the WAL or libSQL race reports busy, see PLAN.md §7 risk 3 and record the decision.</acceptance_criteria>
    <done>RateLimiterStore has a contract on every adapter.</done>
  </task>

  <task type="auto">
    <name>Task 3: delete the hand-wired SQL tests</name>
    <files>packages/sql/test/RateLimiterStoreSql.test.ts, packages/sql/test/RateLimiterStoreSql.postgres.test.ts</files>
    <read_first>both files; grep -rn "RateLimiterStoreSql.test\|RateLimiterStoreSql.postgres" across the repo, excluding .planning</read_first>
    <action>Delete both files. Their store cases are now suite entries or sql cases. The two limiter-over-SQL cases ("drives RateLimiter.layer end to end…" and "escalation doubles the wait…") are dropped on purpose: packages/ports/test/RateLimiter.test.ts covers RateLimiter.layer on memory, and the suite proves the SQL store answers increment and peek as memory does (PLAN.md §3.6, Q3). If grep finds a reference outside .planning, spec and the READMEs, fix it here. The spec pointer and the READMEs belong to tickets 11 and 12. Ticket 02 already removed the scripts/test-pg.sh list entry.</action>
    <verify><automated>test ! -e packages/sql/test/RateLimiterStoreSql.test.ts &amp;&amp; test ! -e packages/sql/test/RateLimiterStoreSql.postgres.test.ts &amp;&amp; pnpm exec vitest run packages/sql packages/ports/test/RateLimiter.test.ts</automated></verify>
    <acceptance_criteria>Both files are gone (they exist at HEAD). The sql and ports suites pass.</acceptance_criteria>
    <done>One bar for the rate-limiter store; nothing runs on the default schema.</done>
  </task>
</tasks>

<threat_model>
## Where trust changes

| Crossing | Description |
|---|---|
| Test run to database | `RateLimiterStoreSql.postgres.test.ts` ran `DROP TABLE` on the connection's default schema of whatever `AWTHAQ_POSTGRES_URL` names |

## STRIDE register

| Threat ID | Category | Target | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-37-03 | Tampering | `DROP TABLE rate_limit_buckets` in the default schema | medium | mitigate | The file is deleted. Every rate-limiter case now runs in a `TestSql` schema (`t_store_contract_w<n>`) that the run creates and drops |
| T-37-04 | Denial of service (rate limiting) | A non-atomic `RateLimiterStore` adapter lets concurrent callers exceed a limit (BEH-EA-105) | high | mitigate | The race case runs on every adapter; the read-then-write mutant proves it is caught |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
pnpm test:pg packages/test/test/StoreContract.sql.test.ts when a Postgres is reachable (the SQL adapter's statement is unchanged; this proves the race on READ COMMITTED). Otherwise report Postgres unavailable.
</verification>

<success_criteria>
- `RateLimiterStore` cases on Postgres: 1 → 7.
- Memory race cases for `RateLimiterStore`: 0 → 1.
- The read-then-write mutant fails the race case.
- 46 of 46 store operations carry verdicts.
</success_criteria>

## Comments

Done (uncommitted). `rateLimiterStore` suite (increment: 3 atomic + 1 race; peek: 1 read; sql: sweeper, missing table) in `internal/storeContract/rateLimiterStore.ts`, added to `Suites`/`suites`/`run`. Memory bundle = `Persistence.memory` + `RateLimiter.layerStoreMemory` (coverage excludes `RateLimiterMemoryStats`); SQL base also runs `RateLimiterStoreSql.migrate`, bundle merges `layerStoreSql`; sealed unchanged. Read-then-write mutant test fails `increment [race]` as required. Deleted `packages/sql/test/RateLimiterStoreSql.test.ts` and `.postgres.test.ts` (Q3: the two limiter-over-SQL cases dropped). Rate-limiter cases: memory 0 -> 5 entries, SQLite/WAL/libSQL 7 each, Postgres 1 -> 7 (by construction, not run). Remaining references to the deleted file: `spec/behaviors/14-rate-limiting.md:15` (ticket 11). vitest packages/test+ports+sql: 949 passed. Postgres (test:pg) not run.
