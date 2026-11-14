# Phase 3 Gate Baseline

**HEAD at capture:** `241554c6ec4611419f5b8dd064caacaea2244b13` (branch `architecture/deepening-batch-3`; phase base commit `e74a8a9a`, only `.planning/` changed since)
**Captured:** 2026-11-14, on a tree where `git diff --quiet e74a8a9a -- packages spec features .changeset knip.json scripts` exits 0 (Step-A precondition met before the first gate and re-checked at the end of the capture)
**Toolchain:** node v26.13.0, pnpm 11.20.0, `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`, vitest 5.0.2
**Method:** each gate run on its own from the worktree root in the order below, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/` (its 1 s is a near up-to-date incremental build). Output of every gate saved outside the repo.

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output), 0 `error TS` | 1 s |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 6 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 5 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 1 s |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 1 s |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 0 s (<1 s) |
| lint | `pnpm lint` | 0 | oxlint: warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors | 2 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1210 files` | 1 s |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 1 s |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 1 s |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1576 passed, 44 skipped (1620) | 20 s |
| unit | `pnpm test` | 0 | Test Files 411 passed, 4 skipped (415); Tests 6491 passed, 1 expected fail, 15 skipped (6507) | 116 s |
| coverage | `pnpm coverage` | 0 | Statements 91.66, Branches 85.08, Functions 86.93, Lines 92.18 (floors 89 / 83 / 84 / 90); same 411 / 4 skipped files, 6491 / 1 expected fail / 15 skipped tests | 143 s |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 108 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 86 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 114 s |

Versus the Phase 2 baseline: one more test file and one more test (411 / 6491 against 410 / 6490), the Phase 2 `TestAuthSurface.test.ts`; coverage 91.66 / 85.08 / 86.93 / 92.18 against 91.65 / 85.08 / 86.91 / 92.17.

Not run locally: `pnpm test:pg` and every Postgres-gated case (see "Postgres" below); they are skipped inside the counts above.

## Phase-specific pins

| Pin | Command | Exit | Summary line printed | Wall time |
|-----|---------|------|----------------------|-----------|
| StoreContract (5 modes) | `npx vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts packages/test/test/StoreContract.sealed.test.ts` | 0 | Test Files 5 passed (5); Tests 457 passed (457) | 6 s |
| records contracts | `npx vitest run packages/admin/test/Contract.test.ts packages/organization/test/Contract.test.ts` | 0 | Test Files 2 passed (2); Tests 641 passed (641) | 11 s |
| listing domain and HTTP | `npx vitest run packages/core/test/Users.test.ts packages/admin/test/Admin.test.ts packages/admin/test/AdminTenants.test.ts packages/admin/test/AuthHttp.test.ts packages/admin/test/AdminUsers.test.ts` | 0 | Test Files 5 passed (5); Tests 79 passed (79) | 5 s |
| SQL adapters | `npx vitest run packages/sql/test/UserStoreSql.test.ts packages/sql/test/CoreStoresSql.test.ts` | 0 | Test Files 2 passed (2); Tests 14 passed (14) | 3 s |

## knip (raw)

Full `pnpm knip` output (trailing whitespace trimmed), exit code 1: 39 `Unused files` rows, all under the untracked `.claude/` tree (`.claude/gsd-core/bin/*.cjs`, `.claude/hooks/*`, `.claude/scripts/*`, identical to the Phase 2 list), then:

```text
$ knip
Unused files (39)
.claude/... (39 rows, all under .claude/, unchanged from the Phase 2 capture)
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

No unused exports, no unused dependencies, nothing under `packages/` other than the three `readme-quickstart.ts` unlisted-dependency rows. (Identical to the Phase 1 and Phase 2 baselines.)

## Working tree at capture

`git status --short` (verbatim, taken after the gates):

```text
?? .claude/.gsd-profile
?? .claude/agents/
?? .claude/commands/
?? .claude/gsd-core/
?? .claude/gsd-file-manifest.json
?? .claude/gsd-install-state.json
?? .claude/hooks/
?? .claude/scripts/
?? .planning/state.json
```

`git diff --stat knip.json` (verbatim):

```text
(empty: knip.json is unmodified at capture)
```

Recorded as found; nothing was reverted or edited.

## KEY-06 grep baseline

Command (scoped to the five listing-owning packages; webhooks is outside the scope, see below):

```text
grep -rEn 'pageLimit|listLimit|MAX_PAGE_SIZE|DEFAULT_PAGE_SIZE|MAX_LIST_LIMIT|DEFAULT_LIST_LIMIT' packages/core/src packages/admin/src packages/organization/src packages/ports/src packages/sql/src
```

Output (verbatim, 16 lines):

```text
packages/core/src/Users.ts:381:const DEFAULT_LIST_LIMIT = 50;
packages/core/src/Users.ts:556:const MAX_LIST_LIMIT = 200;
packages/core/src/Users.ts:558:const listLimit = (limit: number | undefined): number =>
packages/core/src/Users.ts:560:    ? DEFAULT_LIST_LIMIT
packages/core/src/Users.ts:561:    : Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
packages/core/src/Users.ts:818:        .listPage({ after: Option.fromNullishOr(input?.cursor), limit: listLimit(input?.limit) })
packages/admin/src/AdminTenants.ts:199:          const limit = ImpersonationRecords.pageLimit(input?.limit);
packages/admin/src/AdminApi.ts:160:export const MAX_PAGE_SIZE = 200;
packages/admin/src/AdminApi.ts:162:  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
packages/admin/src/ImpersonationRecords.ts:38:import { MAX_PAGE_SIZE } from "./AdminApi.ts";
packages/admin/src/ImpersonationRecords.ts:108:export const DEFAULT_PAGE_SIZE = 50;
packages/admin/src/ImpersonationRecords.ts:111:export const pageLimit = (limit: number | undefined) =>
packages/admin/src/ImpersonationRecords.ts:113:    ? DEFAULT_PAGE_SIZE
packages/admin/src/ImpersonationRecords.ts:114:    : Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
packages/admin/src/ImpersonationRecords.ts:458:        const limit = pageLimit(input?.limit);
packages/admin/src/ImpersonationRecords.ts:768:      const limit = pageLimit(input?.limit);
```

Per file: `Users.ts` 6, `ImpersonationRecords.ts` 7, `AdminApi.ts` 2, `AdminTenants.ts` 1.

Intentional out-of-scope survivor (KEY-07, CONTEXT Decided: KEY-06 grep scope), `grep -n 'MAX_PAGE_SIZE\|DEFAULT_PAGE' packages/webhooks/src/WebhooksApi.ts packages/webhooks/src/Webhooks.ts`:

```text
packages/webhooks/src/WebhooksApi.ts:138:export const MAX_PAGE_SIZE = 200;
packages/webhooks/src/WebhooksApi.ts:146:      Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
packages/webhooks/src/Webhooks.ts:183:const DEFAULT_PAGE = 50;
packages/webhooks/src/Webhooks.ts:760:            limit: query.limit ?? DEFAULT_PAGE,
```

Webhook deliveries keep their own clamp by decision; the phase must leave these four lines in place.

## Structural keyset baselines

Measured at HEAD above.

1. Code (non-comment) sites that add one to a page limit. Command: `grep -vE '^\s*(//|\*|/\*)' packages/sql/src/UserStoreSql.ts packages/admin/src/ImpersonationRecords.ts packages/admin/src/AdminTenants.ts packages/organization/src/OrganizationRecords.ts packages/ports/src/UserStore.ts packages/core/src/Users.ts | grep -cE 'limit \+ 1'` prints **5**. The five sites (line-level `grep -nE 'limit \+ 1'`, comment lines among them excluded from the count): `UserStoreSql.ts:187`, `UserStoreSql.ts:191`, `ImpersonationRecords.ts:466`, `ImpersonationRecords.ts:702`, `AdminTenants.ts:202`.
2. Expanded-OR keyset predicates. `grep -cE 'OR \("(createdAt|startedAt)"' packages/sql/src/UserStoreSql.ts packages/admin/src/ImpersonationRecords.ts`:

   ```text
   packages/sql/src/UserStoreSql.ts:1
   packages/admin/src/ImpersonationRecords.ts:1
   ```

3. Hand-spelled keyset ORDER BY. `grep -cE 'ORDER BY "(createdAt|startedAt)"' packages/sql/src/UserStoreSql.ts packages/admin/src/ImpersonationRecords.ts packages/organization/src/OrganizationRecords.ts`:

   ```text
   packages/sql/src/UserStoreSql.ts:2
   packages/admin/src/ImpersonationRecords.ts:1
   packages/organization/src/OrganizationRecords.ts:2
   ```

   (The first capture printed the three rows in a different order; the counts are the same: 2, 1, 2.)
4. Hand-written memory comparators and their lines: `UserStore.byCreation` at `packages/ports/src/UserStore.ts:184` (sole consumer `.sort(byCreation)` at `:362`); `newestFirst` at `packages/admin/src/ImpersonationRecords.ts:194` (used `:460`), `isBeforeCursor` at `:202` (used `:464`), `toPage` at `:209` (used `:466` and `:779`); the inline organization sort and cursor filter in the memory `listPage` at `packages/organization/src/OrganizationRecords.ts:211-232` (sort `:215-221`, filter `:222-230`, `.slice(0, limit)` at `:231`).
5. Page-field reads of the users store. `cat packages/core/src/Users.ts packages/test/src/internal/storeContract/users.ts packages/sql/test/CoreStoresSql.test.ts features/step-definitions/PersistenceMigrationSteps.ts | grep -cE '\b(page|first|second|third|one|exact)\.next\b'` prints **12**.

## KEY-07 untouched paths

Phase base commit: `e74a8a9a`. These paths must show no diff at phase close (Membership offset paging stays by decision, KEY-F1 deferred; `SessionStore.listLive`, audit log, relay cursor, SCIM, webhooks and SAML are out of scope):

- `packages/organization/src/MembershipRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationHandlers.ts`, `packages/organization/src/OrganizationApi.ts`
- `packages/ports/src/SessionStore.ts`, `packages/ports/src/AccountStore.ts`, `packages/ports/src/AuditLogStore.ts`
- `packages/sql/src/SessionStoreSql.ts`, `packages/sql/src/AuditLogStoreSql.ts`, `packages/sql/src/RelayCursorStoreSql.ts`
- `packages/scim`, `packages/webhooks`, `packages/saml`

Proof command, which must print nothing at phase close:

```text
git diff --stat e74a8a9a HEAD -- packages/organization/src/MembershipRecords.ts packages/organization/src/Organization.ts packages/organization/src/OrganizationHandlers.ts packages/organization/src/OrganizationApi.ts packages/ports/src/SessionStore.ts packages/ports/src/AccountStore.ts packages/ports/src/AuditLogStore.ts packages/sql/src/SessionStoreSql.ts packages/sql/src/AuditLogStoreSql.ts packages/sql/src/RelayCursorStoreSql.ts packages/scim packages/webhooks packages/saml
```

## Postgres

`pnpm test:pg` was **not run locally**, and neither was any Postgres-gated case: the `docker` CLI 29.1.3 is installed, the daemon is down (`docker info` prints the client section then fails to reach the server), and `AWTHAQ_POSTGRES_URL` is unset. Postgres-gated cases are skipped inside the counts above (the SQL legs of `StoreContract` and `RecordsContract` ran on SQLite `:memory:`, the file and libSQL modes on SQLite).

CI path: `.github/workflows/check.yml` runs `pnpm check` (so also `pnpm coverage` and `pnpm test:bdd`) against a `postgres:16` service container with `AWTHAQ_POSTGRES_URL` set to `postgres://awthaq:awthaq@localhost:5432/awthaq_test`; the Postgres cases run there, not through `pnpm test:pg` literally. The local script `scripts/test-pg.sh` uses `postgres:16-alpine`, whose collation is C-like and hides the drift the Debian `postgres:16` image (glibc `en_US.utf8`) shows.

## Known intermittent

`packages/passkey/test/Contract.test.ts > runPluginContractTests > RecordsContract: passkey > ... ChallengeStore (memory) > consume [atomic]: false for any other value, a tampered one included` is a known intermittent from Phase 2 planning (cause not investigated, outside this phase's allowlist). It did not occur in this capture (`pnpm test` and `pnpm coverage` green first time). Rule: if a command's only failure is this case, re-run that command once and record both runs; any other failure is a real regression.

## Phase-close comparison rule

Every gate exits as it did here: all gates 0 except `pnpm knip`, which exits 1 for the pre-existing reasons above.

- Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `PASS 32 / FAIL 0` (a new BEH id is avoided; BEH-EA-036 is amended in place).
- `pnpm check:error-tags` and `pnpm check:contract-tests` print the same numbers as above (163 / 137, 21 plugin classes).
- knip's filtered output keeps only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, with no row under `packages/ports/src`, `packages/sql/src`, `packages/admin/src`, `packages/core/src` or `packages/organization/src`; `git diff --stat knip.json` stays empty.
- The KEY-06 grep above prints **0** lines; the webhooks survivor lines stay as they are.
- The add-one count over the six listing files prints **0**, and `packages/ports/src/Keyset.ts` holds the only `limit + 1`.
- The expanded-OR and hand-spelled keyset ORDER BY counts print 0 in every file.
- The KEY-07 `git diff --stat e74a8a9a HEAD` over the listed paths is empty.
- `packages/admin/test/KeysetCursors.test.ts` only gains lines after 03-01 (checked by `git diff` showing additions only); the six literals and the two schema pins are never edited.
- The Wave 0 pin files (the files 03-02 adds as pins, checked by `git diff` since their add commits) are byte-unchanged after 03-02.
- The phase allowlist is the one 03-09 checks, measured from `e74a8a9a` with `git diff --name-only e74a8a9a HEAD`: only files under `packages/{ports,sql,core,admin,organization}/{src,test}/`, `packages/test/src/internal/storeContract/users.ts`, `features/step-definitions/{PersistenceMigrationSteps,TenancyWorld}.ts`, `spec/behaviors/05-persistence-stratum.md`, `spec/overview.md`, `spec/traceability.md`, `.changeset/keyset-page-module.md` and `.planning/`. `knip.json` is unchanged and no `.cjs`/`.mjs` file is added by the phase.
