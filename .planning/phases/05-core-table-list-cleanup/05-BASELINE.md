# Phase 5 Gate Baseline

**HEAD at capture:** `adfaf4bf2978a928a920af5956005686d836e95d` (branch `architecture/deepening-batch-3`; phase base commit `ea56a16f`, only `.planning/` changed since)
**Captured:** 2026-11-14, on a tree where `git diff --quiet ea56a16f -- packages spec features examples .changeset knip.json scripts` exits 0 (precondition met before the first gate and re-checked after the Postgres runs: exit 0 both times). `docker exec awthaq-p3-pg pg_isready -U postgres` exits 0 (`/var/run/postgresql:5432 - accepting connections`).
**Toolchain:** node v26.13.0, pnpm 11.20.0, `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`
**Postgres server:** `PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`
**Method:** each gate run on its own from the worktree root in the order below with `AWTHAQ_POSTGRES_URL` unset, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/` (its 1 s is an up-to-date incremental build). Output of every gate saved outside the repo. The suite wall times are longer than the Phase 4 capture (cold vitest transform cache and a loaded machine); they are not a signal.

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output), 0 `error TS` | 1 s |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 7 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 6 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 1 s |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 1 s |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 1 s |
| lint | `pnpm lint` | 0 | oxlint: warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors, none under `packages/` | 2 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1224 files` | 1 s |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 1 s |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 0 s (<1 s) |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | 30 s |
| unit | `pnpm test` | 0 on the second run (see "Known intermittents") | Test Files 420 passed, 6 skipped (426); Tests 6676 passed, 1 expected fail, 22 skipped (6699) | 48 s (run 2) |
| coverage | `pnpm coverage` | 0 | Statements 91.75, Branches 85.24, Functions 87.06, Lines 92.27 (floors 89 / 83 / 84 / 90); same 420 / 6 skipped files, 6676 / 1 expected fail / 22 skipped tests | 152 s |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 125 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 95 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 41 s |

Versus the Phase 4 close (426 files / 6690 passed on Postgres; 420 files / 6648 passed on SQLite): SQLite now 420 passed + 6 skipped files, 6676 passed (+28 over the Phase 4 close: the Phase 4 review-fix tests), bdd 1580 / 44 skipped unchanged; coverage 91.75 / 85.24 / 87.06 / 92.27 against 91.73 / 85.22 / 87.03 / 92.25.

## Phase pins

| Pin | Command | Exit | Summary line printed | Wall time |
|-----|---------|------|----------------------|-----------|
| sql, test and core pins | `npx vitest run packages/sql/test/TenantScoped.test.ts packages/sql/test/CoreMigrations.test.ts packages/sql/test/SealedColumn.test.ts packages/test/test/ReadRouting.test.ts packages/test/test/CoreSealedColumns.test.ts packages/core/test/AuthTenancy.test.ts` | 0 | Test Files 6 passed (6); Tests 81 passed (81) | 2 s |
| tenancy feature pin | `pnpm --filter @awthaq/features exec vitest run features/12-multi-tenancy/28-tenancy.steps.test.ts` | 0 | Test Files 1 passed (1); Tests 60 passed, 7 skipped (67) | 3 s |

## knip (raw)

Full `pnpm knip` output (trailing whitespace trimmed), exit code 1: 39 `Unused files` rows, all under the untracked `.claude/` tree (the same list as the Phase 1 to 4 captures), then:

```text
$ knip
Unused files (39)
.claude/... (39 rows, all under .claude/)
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

Filtered form, `pnpm knip 2>&1 | grep -v '^\.claude/' | grep -v '^\.reports/'`:

```text
$ knip
Unused files (39)
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

No unused exports, no unused dependencies, nothing under `packages/` other than the three `readme-quickstart.ts` unlisted-dependency rows. (Identical to the Phase 1 to 4 baselines.)

## Working tree at capture

`git status --short` (verbatim, taken after the gates and the Postgres runs, before any phase-5 commit):

```text
 M .planning/STATE.md
 M .planning/state.json
?? .claude/.gsd-profile
?? .claude/agents/
?? .claude/commands/
?? .claude/gsd-core/
?? .claude/gsd-file-manifest.json
?? .claude/gsd-install-state.json
?? .claude/hooks/
?? .claude/scripts/
```

`git diff --stat knip.json` (verbatim): empty (`knip.json` is unmodified at capture). Recorded as found; nothing was reverted or edited.

## Postgres

Container `awthaq-p3-pg`, image Debian `postgres:16` (server string above), `postgres://postgres:pw@localhost:55433/awthaq` (a throwaway local credential); this is the image CI uses (`.github/workflows/check.yml` runs `postgres:16`), not `scripts/test-pg.sh`'s alpine image. `AWTHAQ_POSTGRES_URL` was passed explicitly on each command below.

| Run | Command | Exit | Summary line printed | Failing tests | Wall time |
|-----|---------|------|----------------------|---------------|-----------|
| targeted legs | `npx vitest run packages/sql/test/TenantScope.postgres.test.ts packages/sql/test/CoreMigrations.postgres.test.ts packages/sql/test/ReadRouting.postgres.test.ts packages/sql/test/TenantScoped.test.ts packages/sql/test/CoreMigrations.test.ts packages/test/test/CoreSealedColumns.test.ts` | 0 | Test Files 6 passed (6); Tests 56 passed (56) | none | 5 s |
| full unit | `pnpm test` | 0 | Test Files 426 passed (426); Tests 6718 passed, 1 expected fail, 1 skipped (6720) | none | 114 s |
| full bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | none | 26 s |

Verbatim failing-test list for the Postgres full-suite record: empty. There are no pre-existing Postgres failures at this HEAD, and no "server closed the connection" or segfault symptom appeared (the full run did not exhaust the container's shared memory).

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

## Census

Every command run from the worktree root at `adfaf4bf`, output verbatim.

1. The quoted `verification_reservations` grep, `grep -rnE '"verification_reservations"' packages/*/src features/step-definitions` (4 lines):

   ```text
   packages/test/src/LaggingReplica.ts:36:  "verification_reservations",
   features/step-definitions/TenancySteps.ts:75:  "verification_reservations",
   features/step-definitions/TenancySteps.ts:482:      case "verification_reservations":
   packages/sql/src/TenantScope.ts:48:  "verification_reservations",
   ```

2. The list-name grep, `grep -rnE 'partitionedTables|directoryTables|coreTables|STAMPED_TABLES|CoreTables' packages/*/src features/step-definitions`, with each line classified:

   ```text
   packages/core/src/Auth.ts:779:const coreTables: ReadonlyArray<string> = [          (projection of TenantScope's two lists, concat)
   packages/core/src/Auth.ts:780:  ...TenantScope.partitionedTables,                    (projection)
   packages/core/src/Auth.ts:781:  ...TenantScope.directoryTables,                      (projection)
   packages/core/src/Auth.ts:886:      if (coreTables.includes(tenancy.parent)) continue;   (its one use: the Derived-parent check)
   features/step-definitions/TenancySteps.ts:70:const STAMPED_TABLES = [                       (REAL COPY, private six-name literal)
   features/step-definitions/TenancySteps.ts:123:  assert.ok(STAMPED_TABLES.includes(table), `"${table}" is not a stamped table`);   (its one use)
   packages/test/src/LaggingReplica.ts:31:export const coreTables: ReadonlyArray<string> = [   (REAL COPY, exported; six names)
   packages/test/src/LaggingReplica.ts:59:    const tables = options.tables ?? coreTables;       (its one use)
   packages/sql/src/TenantScope.ts:45:export const partitionedTables = [                  (SOURCE list, 4 names)
   packages/sql/src/TenantScope.ts:53:export const directoryTables = ["users", "accounts"] as const;   (SOURCE list, 2 names)
   packages/sql/src/TenantScope.ts:105:    ...partitionedTables.map(...)                      (use inside coverage)
   packages/sql/src/TenantScope.ts:107:      ? directoryTables.map(...)                       (use inside coverage)
   features/step-definitions/PersistenceMigrationSteps.ts:511:      const coreTables = yield* tableRows();      (a LOCAL VARIABLE read from the database, not a list)
   features/step-definitions/PersistenceMigrationSteps.ts:523:      const coreUnchanged = coreTables.every((row) =>   (its use)
   ```

3. The two unclassified tables, `grep -nE 'auth_relay_cursor|rate_limit_buckets' packages/sql/src/TenantScope.ts packages/test/src/LaggingReplica.ts packages/core/src/Auth.ts features/step-definitions/TenancySteps.ts` prints nothing (grep exit 1): `auth_relay_cursor` (core migration 27, `CoreMigrations.ts:603`) and `rate_limit_buckets` (`RateLimiterStoreSql.migrations`, tracked in `awthaq_rate_limiter_migrations`) are in none of the four lists.

4. The private BDD six-name literal and its doc comment, `sed -n 69,77p features/step-definitions/TenancySteps.ts` (the `TenancySteps.ts:75` row above is its `verification_reservations` line):

   ```text
   /** The tables `BEH-EA-231` names; the only identifiers ever spliced into a query. */
   const STAMPED_TABLES = [
     "users",
     "accounts",
     "sessions",
     "verification_tokens",
     "verification_reservations",
     "auth_audit_log",
   ];
   ```

   `TenancySteps.ts:482` is a `case "verification_reservations":` label of the per-table insert switch: behaviour, it stays.

5. The dependency edges, `grep -n '"@awthaq/sql"' packages/core/package.json packages/test/package.json features/package.json`:

   ```text
   packages/core/package.json:34:    "@awthaq/sql": "workspace:*"
   packages/test/package.json:36:    "@awthaq/sql": "workspace:*",
   features/package.json:33:    "@awthaq/sql": "workspace:*",
   ```

6. The counts: `grep -c 'export \* as CoreTables' packages/sql/src/index.ts` = 0; `grep -c 'as const' packages/sql/src/TenantScope.ts` = 2; `grep -c 'coreTables' packages/core/src/Auth.ts` = 2; `grep -cE '^  "(users|accounts|sessions|verification_tokens|verification_reservations|auth_audit_log)",$' packages/test/src/LaggingReplica.ts` = 6.

## CAT-04 disposition

The four lists and their class:

| List | File | Names | Class |
|------|------|-------|-------|
| `partitionedTables` + `directoryTables` | `packages/sql/src/TenantScope.ts:45,53` | 4 + 2 | source of truth (RLS coverage) |
| `coreTables` | `packages/test/src/LaggingReplica.ts:31` | 6 (users, accounts, sessions, verification_tokens, verification_reservations, auth_audit_log) | real hand copy, exported |
| `STAMPED_TABLES` | `features/step-definitions/TenancySteps.ts:70` | 6, same names | real hand copy, private |
| `coreTables` | `packages/core/src/Auth.ts:779` | concat of the two TenantScope lists | projection, not a copy |

The two core tables in no list: `auth_relay_cursor` (created by core migration 27, `packages/sql/src/CoreMigrations.ts:603`; the event relay's persisted position, one row per named relay, read and written through `RelayCursorStoreSql.ts` and `EventRelay.ts`) and `rate_limit_buckets` (created only when a composition opts in to `RateLimiterStoreSql.migrate`, tracked in its own ledger `awthaq_rate_limiter_migrations`, `RateLimiterStoreSql.migrationsTable`; a primary-only read-modify-write counter).

Decision: the roadmap's minimal-fix branch (fix only the `LaggingReplica` copy and stop) was conditional on `LaggingReplica` being the only real copy. The BDD six-name literal is a second real copy, and two core tables are classified nowhere, so the branch is NOT taken. The candidate closes with the catalogue (CAT-01 to CAT-03): 05-06 closes CAT-04 with the census pair (this census and the one at phase close).

CONTEXT correction: CONTEXT cites the `RateLimiterStoreSql.ts` header ("a limit is not multiplied by the replica count") as the reason `rate_limit_buckets` is not replicated. That sentence is about application replicas (processes) sharing one table, not database read replicas. The exclusion stands; its reason is the read-routing one (a primary-only read-modify-write counter, never a display or history listing, ADR-EA-024 decision 2) plus the opt-in creation path.

## Spec facts

Confirmed at this HEAD (RESEARCH had flagged them as guesses): `spec/behaviors/28-tenancy.md` Revision 1.15 (BEH-EA-231 at `:31`, 232 at `:48`, 233 at `:63`, 328 at `:208`), `spec/overview.md` Revision 1.18 (package-map row `:48`), `spec/traceability.md` Revision 1.93 (section 5 "Test file -> what it covers" from `:199`). The sealed columns are BEH-EA-324 and BEH-EA-339. BEH-EA-037 is "A plugin's migrations are v4 `Migrator` records" and is NOT a core-table behaviour: it is not cited by this phase.

## Known intermittents

1. The first `pnpm test` run of this capture failed on `packages/passkey/test/Contract.test.ts > runPluginContractTests > RecordsContract: passkey > RecordsContract: awthaq/passkey/records/ChallengeStore (memory) > consume [atomic]: false for any other value, a tampered one included` (the Phase 2 known intermittent, this time in the memory variant rather than `(sql)`): `Test Files 1 failed | 419 passed | 6 skipped (426)`, `Tests 1 failed | 6675 passed | 1 expected fail | 22 skipped (6699)`, exit 1, 138 s. It was the run's only failure.
2. The one re-run was green: exit 0, `Test Files 420 passed | 6 skipped (426)`, `Tests 6676 passed | 1 expected fail | 22 skipped (6699)`, 48 s. `pnpm coverage` (the same suite) was green first time. The gate table's unit row is that green run.
3. The second known intermittent, `packages/organization/test/TenantMiddleware.test.ts > ... a suspended organization still resolves (the plugin's own gate refuses it)`, did not fire in this capture. Rule for later plans: a command whose only failures are one of the two cases is re-run (twice at most) and every run is recorded; any other failure is a real regression.

## Phase-close comparison rule

Every gate exits as it did here: all gates 0 except `pnpm knip`, which exits 1 for the pre-existing reasons above.

- Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `FAIL 0` (the PASS count is 32 here and may only grow).
- `pnpm check:error-tags` and `pnpm check:contract-tests` print the same numbers as above (163 / 137, 21 plugin classes).
- knip's filtered output gains nothing: only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, with no row under `packages/`; `git diff --stat knip.json` stays empty.
- The Postgres full-suite failing list (empty here) does not grow, and every targeted leg above plus `packages/sql/test/CoreTablePins.test.ts` and `packages/sql/test/CoreTables.test.ts` pass on Postgres (record again as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)").
- Census expectations at close: the quoted `verification_reservations` grep prints 2 lines (one in `packages/sql/src/CoreTables.ts`, the `case` label in `TenancySteps.ts`); the list-name counts (`coreTables` in `Auth.ts`, `STAMPED_TABLES` in `TenancySteps.ts`) are 0; `as const` in `TenantScope.ts` is 0; the barrel export count (`grep -c 'export \* as CoreTables' packages/sql/src/index.ts`) is 1.
- No new dependency: `git diff --stat ea56a16f HEAD -- packages/*/package.json features/package.json pnpm-lock.yaml` prints nothing.
- The Wave 0 oracle files `packages/sql/test/CoreTablePins.test.ts` and `packages/test/test/LaggingReplica.test.ts` have exactly one commit each since `ea56a16f` (`git log --format=%h ea56a16f..HEAD -- <file>`), and `packages/core/test/AuthTenancy.test.ts` and `packages/sql/test/TenantScope.postgres.test.ts` only gained lines (`git diff ea56a16f -- <file> | grep -c '^-[^-]'` prints 0).
- The path allowlist for `git diff --name-only ea56a16f HEAD` (every line must match): `^(packages/sql/src/(CoreTables|TenantScope|index)\.ts$|packages/sql/test/(CoreTablePins|CoreTables|TenantScope\.postgres)\.test\.ts$|packages/sql/README\.md$|packages/test/src/LaggingReplica\.ts$|packages/test/test/LaggingReplica\.test\.ts$|packages/core/src/Auth\.ts$|packages/core/test/AuthTenancy\.test\.ts$|features/step-definitions/TenancySteps\.ts$|spec/(behaviors/28-tenancy|overview|traceability)\.md$|\.changeset/core-table-catalogue\.md$|\.planning/)`.

## Wave 0 pins

(filled by 05-01 Task 2 and 05-02)
