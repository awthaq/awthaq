# Phase 6 Gate Baseline

**HEAD at capture:** `567c698530d96a7805ab067a8df347430048e5ce` (branch `architecture/deepening-batch-3`; phase base commit `3be32564`, only `.planning/` changed since)
**Captured:** 2026-11-14, on a tree where `git diff --quiet 3be32564 -- packages spec features examples docs .changeset knip.json scripts` exits 0 (precondition met before the first gate and re-checked after the last: exit 0 both times). `docker exec awthaq-p3-pg pg_isready -U postgres` exits 0 (`/var/run/postgresql:5432 - accepting connections`).
**Toolchain:** node v26.13.0, pnpm 11.20.0, `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`
**Method:** each gate run on its own from the worktree root in the order below with `AWTHAQ_POSTGRES_URL` unset, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/` (its 1 s is an up-to-date incremental build). Output of every gate saved outside the repo. Wall times are not a signal (machine load varies).

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output), 0 `error TS` | 1 s |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 3 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 4 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 0 s (<1 s) |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 1 s |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 0 s (<1 s) |
| lint | `pnpm lint` | 0 | oxlint: warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors, none under `packages/` | 1 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1228 files` | 1 s |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 0 s (<1 s) |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 1 s |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | 12 s |
| unit | `pnpm test` | 0 (first run, no intermittent fired) | Test Files 423 passed, 6 skipped (429); Tests 6699 passed, 1 expected fail, 23 skipped (6723) | 75 s |
| coverage | `pnpm coverage` | 0 on the second run (see "Known intermittents") | Statements 91.80, Branches 85.23, Functions 87.12, Lines 92.32 (floors 89 / 83 / 84 / 90); same 423 + 6 skipped files, 6699 / 1 expected fail / 23 skipped tests | 106 s (run 2) |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 57 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 67 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 87 s |

Versus the Phase 5 close (423 + 6 skipped files / 6695 passed / 1 expected fail / 23 skipped; coverage 91.81 / 85.24 / 87.13 / 92.33): SQLite now 6699 passed (+4 over the Phase 5 close's 6695, same 423 + 6 skipped files; no file under `packages/` or `features/` has changed since the phase base, so the difference is run-to-run variation in what executes, e.g. timing-dependent cases, and is not a signal), coverage within 0.01 of the Phase 5 close on each axis, bdd unchanged at 1580 / 44 skipped.

## Phase pins

The record-store Contract command, called RC9 in the plan: the Contract suites of the 8 packages that own the 16 `*Records` modules (`admin`, `api-key`, `device-authorization`, `jwt`, `organization`, `saml`, `scim`, `webhooks`) plus the plugin template (the go branch would edit the template last).

RC9, full command (the nine suite paths, in order):

```text
npx vitest run packages/admin/test/Contract.test.ts packages/api-key/test/Contract.test.ts packages/device-authorization/test/Contract.test.ts packages/jwt/test/Contract.test.ts packages/organization/test/Contract.test.ts packages/saml/test/Contract.test.ts packages/scim/test/Contract.test.ts packages/webhooks/test/Contract.test.ts examples/plugin-template/test/Contract.test.ts
```

The nine suite paths: `packages/admin/test/Contract.test.ts`, `packages/api-key/test/Contract.test.ts`, `packages/device-authorization/test/Contract.test.ts`, `packages/jwt/test/Contract.test.ts`, `packages/organization/test/Contract.test.ts`, `packages/saml/test/Contract.test.ts`, `packages/scim/test/Contract.test.ts`, `packages/webhooks/test/Contract.test.ts`, `examples/plugin-template/test/Contract.test.ts`.

| Pin | Command | Exit | Summary line printed | Wall time |
|-----|---------|------|----------------------|-----------|
| RC9 on SQLite (`AWTHAQ_POSTGRES_URL` unset) | `npx vitest run packages/admin/test/Contract.test.ts packages/api-key/test/Contract.test.ts packages/device-authorization/test/Contract.test.ts packages/jwt/test/Contract.test.ts packages/organization/test/Contract.test.ts packages/saml/test/Contract.test.ts packages/scim/test/Contract.test.ts packages/webhooks/test/Contract.test.ts examples/plugin-template/test/Contract.test.ts` | 0 | Test Files 9 passed (9); Tests 1334 passed (1334) | 20 s |

## knip (raw)

Full `pnpm knip` output (trailing whitespace trimmed), exit code 1: 39 `Unused files` rows, all under the untracked `.claude/` tree (the same list as the Phase 1 to 5 captures), then:

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

No unused exports, no unused dependencies, nothing under `packages/` other than the three `readme-quickstart.ts` unlisted-dependency rows. (Identical to the Phase 1 to 5 baselines.)

## Working tree at capture

`git status --short` (verbatim, taken after the gates, before any phase-6 commit):

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

Container `awthaq-p3-pg`, image Debian `postgres:16` (`PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`; `pg_isready`: `/var/run/postgresql:5432 - accepting connections`), `postgres://postgres:pw@localhost:55433/awthaq` (a throwaway local credential). This is the image CI uses (`.github/workflows/check.yml` runs `postgres:16`), not `scripts/test-pg.sh`'s alpine image. `AWTHAQ_POSTGRES_URL` was passed explicitly on each command. **The container was recreated with `--shm-size=1g` (empty database) before the recorded runs**, after the first attempt on the old container was slowed by leaked per-test schemas (see "First attempt" below). `npx tsc -b tsconfig.json` ran first (exit 0, 1 s).

RC9 (full command and the nine suite paths are in "Phase pins" above), with the Postgres URL prefixed:

```text
AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/admin/test/Contract.test.ts packages/api-key/test/Contract.test.ts packages/device-authorization/test/Contract.test.ts packages/jwt/test/Contract.test.ts packages/organization/test/Contract.test.ts packages/saml/test/Contract.test.ts packages/scim/test/Contract.test.ts packages/webhooks/test/Contract.test.ts examples/plugin-template/test/Contract.test.ts
```

The nine suite paths: `packages/admin/test/Contract.test.ts`, `packages/api-key/test/Contract.test.ts`, `packages/device-authorization/test/Contract.test.ts`, `packages/jwt/test/Contract.test.ts`, `packages/organization/test/Contract.test.ts`, `packages/saml/test/Contract.test.ts`, `packages/scim/test/Contract.test.ts`, `packages/webhooks/test/Contract.test.ts`, `examples/plugin-template/test/Contract.test.ts`.

| Run | Command | Exit | Summary line printed | Failing tests | Wall time |
|-----|---------|------|----------------------|---------------|-----------|
| RC9 (nine suites) | the RC9 command above | 0 | Test Files 9 passed (9); Tests 1346 passed (1346) | none | 81 s |
| full unit, run 1 | `pnpm test` | 1 | Test Files 1 failed, 428 passed (429); Tests 1 failed, 6741 passed, 1 expected fail, 1 skipped (6744) | `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` "an organization deletion racing a create for it leaves no connection, claim or owner row behind, and the create is refused" (third known intermittent, see "Known intermittents") | 229 s |
| the failing file alone, 3 runs | `npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` | 0, 0, 0 | Test Files 1 passed (1); Tests 3 passed (3), each run | none | 4 s, 4 s, 3 s |
| full unit, run 2 | `pnpm test` | 0 | Test Files 429 passed (429); Tests 6742 passed, 1 expected fail, 1 skipped (6744) | none | 97 s |
| full bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | none | 13 s |

Verbatim failing-test list for the Postgres full-suite record: empty on run 2 (the run recorded as the baseline); run 1's single failure is the intermittent above. Every run is listed; the unit row of the baseline is run 2 (green).

RC9 on Postgres versus SQLite: 1346 tests against 1334 (+12), the same 9 files; the extra tests are the Postgres-only cases (the race and atomicity cases that need a real server, and the Postgres-versus-SQLite schema-equivalence case). Full unit on Postgres is 6742 passed against 6699 on SQLite with 1 skipped instead of 23 (the Postgres-only files stop skipping). No "server closed the connection", segfault, "terminated unexpectedly" or "shared memory" symptom in any of the three logs (0 matches for `server closed|segfault|terminated unexpectedly|shared memory`, with the container at `--shm-size=1g`).

### First attempt on the old container (not the baseline)

The first Postgres leg ran on the previous container (default 64 MB `/dev/shm`), whose `awthaq` database had grown to 4733 MB with 5877 leaked per-test schemas and 538,624 `pg_class` rows, while the machine load average was 31 to 49 (external `rustc` builds). It produced a different set of failures on each run, all `Test timed out in 5000ms` except the known passkey intermittent, none with a crash or shared-memory symptom (0 matches): RC9 1 failed of 1346 (admin `ImpersonationRecords (sql)` "create [atomic]: an interrupted create leaves its row and its link together, or neither"), 170 s; full `pnpm test` 3 failed of 6744 (admin `ImpersonationRecords (sql)` "create [race]: 8 creates racing verifyChain never report a break", passkey ChallengeStore (memory) tampered-consume, `OrganizationMembers` "natural race, 8 rounds, no hook: every round leaves an owner"), 207 s; a second RC9 run 3 failed (admin create [atomic], and scim and saml "Postgres and SQLite build the same logical schema"); bdd passed (1580 / 44). Those runs are not recorded as results: the container was recreated with `--shm-size=1g` and an empty database, and the table above is the fresh-container record. Nothing under `packages`, `spec`, `features`, `examples` or `docs` changed in between.

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

`git diff --quiet 3be32564 -- packages spec features examples docs .changeset knip.json scripts` re-checked after the Postgres runs: exit 0.

## Known intermittents

1. `packages/passkey/test/Contract.test.ts` > `runPluginContractTests` > `RecordsContract: passkey` > `RecordsContract: awthaq/passkey/records/ChallengeStore (memory or sql variant)` > `consume [atomic]: false for any other value, a tampered one included`. **Fired in this capture** on the first `pnpm coverage` run (the memory variant): `Test Files 1 failed | 422 passed | 6 skipped (429)`, `Tests 1 failed | 6698 passed | 1 expected fail | 23 skipped (6723)`, exit 1, 84 s; it was that run's only failure. The one re-run was green (exit 0, 106 s, the coverage numbers in the gate table). The first `pnpm test` run (run before coverage) was green first time.
2. `packages/organization/test/TenantMiddleware.test.ts` > `... a suspended organization still resolves (the plugin's own gate refuses it)`. Did not fire in this capture.
3. **New, finding F-06-01:** `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` > "OIDC connection lifecycle races (real Postgres, CONN-03/CONN-05)" > "an organization deletion racing a create for it leaves no connection, claim or owner row behind, and the create is refused" (Postgres only, under parallel load). **Fired in this capture** on the first full Postgres `pnpm test` (assertion, not a timeout: received `create: "ok"` where `create: "InvalidConnection"` was expected; the row counts were all 0). Root cause: the test's helper `waitForAdvisoryWaiters` (`OrganizationConnectionLifecycle.sql.test.ts:178-192`) counts `pg_locks WHERE locktype = 'advisory' AND NOT granted` across the whole database, not for this test's lock key; test files run in parallel against one database, so foreign advisory waiters (for example the `OrganizationMembers` race tests) can satisfy the count early and let the create commit before the delete. It is a defect in the Phase 4 test, not a regression: no `packages` file changed since the Phase 5 close, where the full Postgres run was green. The file passes alone 3 of 3 (3 tests each), and the second full Postgres `pnpm test` was green. A fix scoping the count to the lock key is planned after this phase (not edited here). Fixed by 06-04 (`935cb822`, see Amendments): from 06-04 on a failure of this test is a regression, not an intermittent.

Rule for later plans: a command whose only failures are one of these three cases (two cases from 06-04 on: F-06-01 is fixed, see Amendments) is re-run (at most twice) and every run is recorded; any other failure is a real regression. Runs here: coverage run 1 (exit 1, intermittent 1), coverage run 2 (exit 0); Postgres full unit run 1 (exit 1, intermittent 3), run 2 (exit 0); every other gate ran once.

## Phase-close comparison rule

Every gate exits as it did here, and the comparison is made on a tree where `git diff --stat knip.json` is empty.

1. Every gate exits as here: all 0 except `pnpm knip`, which exits 1 only for the pre-existing findings above.
2. Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `FAIL 0` and `SKIP 0`, with PASS at or above 32 (this capture).
3. `pnpm check:error-tags` and `pnpm check:contract-tests` print the same numbers as here (163 / 137, 21 plugin classes), and `pnpm check:readmes`, `pnpm circular` and `pnpm check:transactions` exit 0.
4. knip's filtered output gains nothing: only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, no row under `packages/` besides them; `git diff --stat knip.json` stays empty.
5. RC9 passes on SQLite and on Postgres (full command and the nine suite paths in "Phase pins" above), and the Postgres full-suite failing list does not grow (empty here; the three known intermittents each allow up to two recorded re-runs, the third being F-06-01 (F-06-01 removed by 06-04, see Amendments); record again as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)").
6. No new dependency: `git diff --stat 3be32564 HEAD -- packages/*/package.json features/package.json examples/*/package.json pnpm-lock.yaml` prints nothing.

### Path allowlist

Every line of `git diff --name-only 3be32564 HEAD` must match the no-go set:

```text
^(spec/decisions/041-domain-store-ports\.md$|\.planning/)
```

and on a no-go, `git diff --quiet 3be32564 HEAD -- packages features examples docs .changeset scripts knip.json pnpm-lock.yaml` exits 0 (no package, docs, template or changeset change: no scaffolding code lands).

This set covers both spike outcomes for the work planned now: plans 06-01 to 06-03 touch only `.planning/` and, at most, `spec/decisions/041-domain-store-ports.md`. A go-branch plan, written only after `06-SPIKE.md` says go, may widen the set solely by appending the exact paths it names: the adopting `packages/*/src/*Records.ts`, the helper module and its test, its Wave 0 pin file, one `.changeset/<name>.md`, `docs/plugin-authoring.md`, `examples/plugin-template/` files, and `spec/overview.md` / `spec/traceability.md` only if the public surface changes. A path not named by such a plan stays outside the allowlist.

#### Go-branch additions

- 06-04: packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts
- 06-05: packages/sql/test/RecordsScaffoldPins.test.ts
- 06-06: packages/organization/test/RecordOrderPins.test.ts, packages/saml/test/RecordOrderPins.test.ts, packages/scim/test/RecordOrderPins.test.ts, packages/webhooks/test/RecordOrderPins.test.ts
- 06-07: packages/sql/src/StoreFailure.ts, packages/sql/test/StoreFailure.test.ts, packages/device-authorization/src/DeviceClientRecords.ts, packages/device-authorization/src/DeviceGrantRecords.ts, packages/api-key/src/ApiKeyClientRecords.ts, packages/api-key/src/ApiKeyRecords.ts, packages/jwt/src/SigningKeyRecords.ts, packages/admin/src/ImpersonationRecords.ts

### Go-branch obligations

Quoting 06-CONTEXT: before any `src` change the go branch pins today's behaviour for every file it touches (operation labels, lock keys, verdicts, ordering/comparator results, tenant visibility) and freezes each module's current `Ref` count rather than asserting one (`ImpersonationRecords` keeps two `Ref`s and a `Semaphore`), and `docs/plugin-authoring.md` and `examples/plugin-template/` update last. The Wave 0 pin files are written and green against untouched `packages/*/src` (`git diff --quiet 3be32564 -- packages/*/src` exits 0 at each Wave 0 commit), every expected value an inline literal.

## Amendments

### 06-04: F-06-01 scoped to its lock keys

PLAN_BASE `f9a0600f`; fix commit `935cb822` (test only: `waitForAdvisoryWaiter(key)` replaces the database-wide `waitForAdvisoryWaiters(count)`; no assertion line changed; the two call sites wait on `LATCH_KEY`, then on `organization_domain_claim:org:<org id>` hashed with `hashtextextended(key, 0)` as `SqlStore.atomically` hashes it).

**Step A, predicate probe (Debian postgres:16.16 container).** One holder session took session advisory locks on `4040405`, `-4040405`, `hashtextextended('probe06:org:x', 0)` and `hashtextextended('probe06:other', 0)`; four waiter sessions, one per key. The key-scoped count (`objsubid = 1 AND NOT granted AND classid/objid = the key's high/low 32 bits`) printed 1 for each of the first three keys; the unscoped `locktype = 'advisory' AND NOT granted` count printed 4. Probe sessions terminated, unscoped count back to 0.

**Step B, pre-fix reproduction at PLAN_BASE** (file alone on Postgres with two foreign waiters on key 606060606 held throughout, harness check 2): FAILED, 1 of 3 tests, the race case, `create: "ok"` received where `"InvalidConnection"` was expected, row counts 0. The planted waiters reproduce F-06-01 deterministically.

**Post-fix runs** (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)):

| # | Run | Result |
|---|-----|--------|
| 1-3 | file alone on Postgres, no foreign waiters | 3 of 3 green, 3 tests each |
| 4-6 | file alone on Postgres, 2 foreign waiters held throughout (check 2 before and after) | 3 of 3 green, 3 tests each |
| 7 | file alone without `AWTHAQ_POSTGRES_URL` (SQLite) | skipped, as before |
| 8 | full `pnpm test` on Postgres, bloated container (1.8 GB, 2492 leaked schemas) | NOT a valid run: 424 s, 3 five-second timeouts (admin ImpersonationRecords `create [atomic]` and `create [race]`, organization `OrganizationMembers` natural race); F-06-01 test passed; not counted |
| 9 | full run, fresh container | exit 1, 1 failed, 6741 passed: only passkey `ChallengeStore consume [atomic]` (known intermittent 1); F-06-01 test passed; 222 s; re-run |
| 10 | full run, fresh container (re-run of 9) | exit 0, 429 files, 6742 passed, 1 expected fail, 1 skipped; 299 s |
| 11 | full run, fresh container | exit 1, 2 failed, 6740 passed: admin `ImpersonationRecords (sql)` `create [atomic]` and `create [race]`, both 5 s timeouts, not a known intermittent; F-06-01 test passed; 165 s; `packages/admin/test/Contract.test.ts` alone on Postgres 3 of 3 green (126 tests) afterwards |
| 12 | full run, fresh container (re-run of 11) | exit 0, 429 files, 6742 passed, 1 expected fail, 1 skipped; 97 s |

Each full run started from an empty database (container recreated with `--shm-size=1g`) except run 8. The F-06-01 test passed in every post-fix run.

**Decision.** F-06-01 is fixed and removed from the known-intermittent list from 06-04 on: the alone runs (6 of 6 green, 3 of them under planted foreign waiters) and two clean full Postgres runs (10 and 12) support it, and no post-fix run failed the F-06-01 test.

**Open finding, not added to the list by this plan.** The admin `ImpersonationRecords (sql)` pair `create [atomic]: an interrupted create leaves its row and its link together, or neither` and `create [race]: 8 creates racing verifyChain never report a break` timed out at 5 s in 2 of 5 full Postgres runs (8, 11) and passed in the other three and alone. It is outside this plan's file and is unrelated to the advisory-waiter helper (it is in a different package and contract). Whether it joins the known-intermittent list is for the phase close to decide; until then a later plan meeting it re-runs once and records it.

**Orchestrator decision (2026-11-14, after 06-04).** The pair joins the known-intermittent list as intermittent 3 (the list is again three entries: passkey ChallengeStore, `TenantMiddleware` "a suspended organization still resolves", and this pair): both are `Test timed out in 5000ms` cases of the admin `ImpersonationRecords (sql)` contract (`RecordsContract.ts:282`) that fire only in a full-suite Postgres run (2 of 5 such runs here; the first attempt on the bloated container hit them too), never alone (3 of 3 green, 126 tests), and no source changed. The allowance is the same as for the others: re-run at most twice and record every run; any other failure is real. The container must be recreated with `pg-fresh.sh` before each full Postgres run, because the test layers leak a schema per layer build and a loaded database makes 5-second budgets flaky. The phase close lists the pair as a load-sensitivity finding (F-06-03, not fixed here: the budget is the contract suite's).

## Wave 0 pins

### 06-05: source-scan pin and declaration hashes

PLAN_BASE `112ccb36`. Pin file `packages/sql/test/RecordsScaffoldPins.test.ts`, add commit `e47f02e2` (the only commit touching it; never edited afterwards). It reads the sixteen record stores, `DomainClaims`, `UserClaims`, `TwoFactorStore` and the plugin template as text and imports none of them, so it has no Postgres leg (a source scan: nothing to run against a database). Four cases, all green on `src` unchanged since `3be32564`:

1. the scanner accepts today's template closure and `StoreFailure.labelled("<Store>")` and refuses a third spelling (a `+` concatenation);
2. every record store's labels, frozen as inline sorted literals (16 modules, 176 strings; the module name is in each assertion message);
3. every `layerMemory`'s `Ref.make` and `Semaphore.make` count;
4. the 11 `SqlStore.atomically` lock-key template literals of 9 files, byte for byte.

Measured per module (labels = calls + writes + direct; Ref, Semaphore as counted; non-literal = calls of the binding whose argument is not a string literal):

| Module | binding | calls | writes | direct | labels | non-literal | Ref | Sem |
|--------|---------|-------|--------|--------|--------|-------------|-----|-----|
| ImpersonationRecords | unavailable | 6 | 0 | 0 | 6 | 0 | 2 | 1 |
| ApiKeyClientRecords | unavailable | 6 | 0 | 1 | 7 | 0 | 1 | 0 |
| ApiKeyRecords | unavailable | 7 | 0 | 1 | 8 | 0 | 1 | 0 |
| DeviceClientRecords | unavailable | 4 | 0 | 0 | 4 | 0 | 1 | 0 |
| DeviceGrantRecords | unavailable | 12 | 0 | 0 | 12 | 0 | 1 | 0 |
| SigningKeyRecords | unavailable | 6 | 0 | 1 | 7 | 0 | 1 | 0 |
| ActiveContextRecords | unavailable | 5 | 4 | 0 | 9 | 2 | 1 | 0 |
| ConnectionRecords | unavailable | 7 | 0 | 4 | 11 | 0 | 1 | 0 |
| InvitationRecords | unavailable | 14 | 0 | 0 | 14 | 0 | 1 | 0 |
| MembershipRecords | unavailable | 9 | 0 | 1 | 10 | 0 | 1 | 0 |
| OrganizationRecords | unavailable | 7 | 0 | 2 | 9 | 0 | 1 | 0 |
| OrgRoleRecords | unavailable | 6 | 0 | 1 | 7 | 0 | 1 | 0 |
| TeamRecords | unavailable | 15 | 0 | 5 | 20 | 0 | 1 | 0 |
| SamlRecords | unavailable | 14 | 0 | 0 | 14 | 0 | 1 | 0 |
| ScimRecords | unavailable | 12 | 0 | 2 | 14 | 0 | 1 | 0 |
| WebhookRecords | failing | 24 | 0 | 0 | 24 | 0 | 1 | 0 |
| Total | | 154 | 4 | 18 | 176 | 2 | 17 | 1 |

Identical to the planner's table. Lock keys (11, 9 files): `organization_team:org:${organizationId}` (TeamRecords); `organization_membership:org:${input.organizationId}`, `organization_membership:owner:${input.userId}`, `organization_membership:org:${organizationId}` (MembershipRecords); `organization_invitation:inviter:${input.inviterId}` (InvitationRecords); `organization_role:org:${input.organizationId}` (OrgRoleRecords); `webhooks_endpoint:tenant:${stamped.tenantId ?? "-"}` (WebhookRecords); `organization_domain_claim:org:${organizationId}` (DomainClaims); `qadi_claims:user:${userId}` (UserClaims); `two_factor_recovery_code:user:${userId}` (TwoFactorStore); `notes_note:owner:${input.owner}` (plugin template).

Results (run locally; the pin has no database leg): `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` clean; `npx vitest run packages/sql/test/RecordsScaffoldPins.test.ts`: `Test Files 1 passed (1)`, `Tests 4 passed (4)`; `pnpm lint` prints no warning for the file and `pnpm format:check` is clean. Mutation check: changing one label literal in the test's own table (`WebhookRecords.claimDue` to `WebhookRecords.claimDu`, a scratch edit before the add commit) turned the labels case red (`Tests 1 failed | 3 passed (4)`), then was restored byte for byte. `grep -cE 'from "(\.\./src/|@awthaq/)'` on the file: 0. `git diff --name-only 3be32564 -- packages examples | grep -c '/src/'` at the add commit: 0.

Declaration hashes: `.planning/phases/06-record-store-scaffolding/06-SHAPE-DTS.sha256` holds `shasum -a 256` of the 16 emitted `packages/<pkg>/lib/<Store>.d.ts` after `npx tsc -b tsconfig.json` on unchanged `src`; `shasum -a 256 -c` prints 16 OK. The `DeviceClientRecords.d.ts` line equals the planner's hash (`a7a3443d...10791`), so no toolchain difference. Every later plan runs `npx tsc -b tsconfig.json` then `shasum -a 256 -c .planning/phases/06-record-store-scaffolding/06-SHAPE-DTS.sha256` and needs 16 OK (no `*Shape`, layer or record type changed).

### 06-06: equal-createdAt order pins

PLAN_BASE `8d09eced`. Four pin files, each added by exactly one commit and never edited afterwards. Every case runs on memory and on SQL (SQLite `:memory:` in `pnpm test`, a Postgres schema under `AWTHAQ_POSTGRES_URL`), against unchanged `src` (`git diff --name-only 3be32564 -- packages examples | grep -c '/src/'` prints 0 at each add commit; the same diff filtered for `/test/contract/` prints 0). Expected orders are inline literals over canonical ids (`X` = `...0009`, `A` = `...0001`, `B` = `...0002`, `C` = `...0003`: X is inserted first, then C, A, B one millisecond later, so time decides before id); for `TeamRecords`, whose ids the store mints, the expected order is the minted ids sorted by `Array.prototype.sort()` with no comparator. A row of another organization, tenant or subject is in every listing case that filters, and must not appear. `grep -cE 'Keyset|localeCompare|toEpochMillis'` over the four files: 0.

| File | Add commit | Tests | SQLite | Postgres |
|------|------------|-------|--------|----------|
| `packages/organization/test/RecordOrderPins.test.ts` | `3b75b1ea` | 6 (3 cases x 2 modes) | 6 passed | 6 passed |
| `packages/saml/test/RecordOrderPins.test.ts` | `726235f8` | 4 (2 x 2) | 4 passed | 4 passed |
| `packages/scim/test/RecordOrderPins.test.ts` | `726235f8` | 6 (3 x 2) | 6 passed | 6 passed |
| `packages/webhooks/test/RecordOrderPins.test.ts` | `726235f8` | 6 (3 x 2) | 6 passed | 6 passed |

22 new tests; with `packages/sql/test/RecordsScaffoldPins.test.ts` (4) the five-file command prints `Test Files 5 passed (5)`, `Tests 26 passed (26)` on SQLite and on Postgres (`postgres://postgres:pw@localhost:55433/awthaq`, container `awthaq-p3-pg`, Debian postgres:16, 16.16). run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote). `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` clean, `pnpm lint` exit 0 with no finding for the files, `pnpm format:check` clean, `pnpm check:contract-tests` prints `all 21 plugin classes run the contract suite`. No pin case was red on unchanged `src`: memory and SQL agree on every one, including the descending `listSpKeys` and the depth-first `getDescendants`.

The 11 comparator sites and the case that pins each (the "re-read" cases were read at `8d09eced` and each inserts rows with an equal `createdAt` and different ids, then asserts the order):

| # | Site | Operation(s) | Direction, tie field | Pinned by |
|---|------|--------------|----------------------|-----------|
| 1 | `packages/device-authorization/src/DeviceClientRecords.ts:55-59` `oldestFirst` | `list` | asc, `clientId` | contract `packages/device-authorization/test/contract/DeviceClientRecords.ts:117` "every client, revoked ones too, oldest first, equal times by client id ascending" (clients `c` and `b` at 2000 ms, expects `a, b, c, d`): ties on createdAt |
| 2 | `packages/api-key/src/ApiKeyClientRecords.ts:75-81` `newestFirst` | `listByOwner` | desc, `clientId` | contract `packages/api-key/test/contract/ApiKeyClientRecords.ts:98` "the owner's clients, newest first, equal times by client id descending; nobody else's" (`b`, `c` at 2000 ms, expects `c, b, a`): ties on createdAt |
| 3 | `packages/api-key/src/ApiKeyRecords.ts:98-102` `newestFirst` | `listByOwner` | desc, `id` | contract `packages/api-key/test/contract/ApiKeyRecords.ts:131` "the owner's keys, newest first, equal times by id descending; nobody else's" (`b`, `c` at 2000 ms, expects `c, b, a`): ties on createdAt |
| 4 | `packages/organization/src/ConnectionRecords.ts:339-343` | `listByOrganization` | asc, `id` | new: `packages/organization/test/RecordOrderPins.test.ts` "ConnectionRecords.listByOrganization: time first, then id, ascending" |
| 5 | `packages/organization/src/MembershipRecords.ts:192-203` `applySort` | `listByOrganization` asc and desc | both, `id` | contract `packages/organization/test/contract/MembershipRecords.ts:332` "equal createdAt orders by id, in both directions (plan 24 R2)" (three creates with no clock advance between them, asserts ascending `[...ids].sort()` and descending reversed): ties on createdAt (the tie is the frozen test clock, not an explicit timestamp) |
| 6 | `packages/organization/src/TeamRecords.ts:364-368` `descendantsIn` | `getDescendants`, `getSubtree` | asc, `id` | new: `packages/organization/test/RecordOrderPins.test.ts` "TeamRecords.getDescendants: depth first, then (createdAt, id) within a level" and "TeamRecords.getSubtree: the team, then its descendants in that order" |
| 7 | `packages/organization/src/TeamRecords.ts:469-473` | `listTeamsByOrganization` | asc, `id` | contract `packages/organization/test/contract/TeamRecords.ts:433` "orders by (createdAt, id) (plan 24 R3)" (`tied-a`, `tied-b` after a `TestClock.adjust`, expects `first` then the tied ids `.sort()`ed): ties on createdAt |
| 8 | `packages/saml/src/SamlRecords.ts:265-270` `byCreation` | `listByOrganization` | asc, `id` | new: `packages/saml/test/RecordOrderPins.test.ts` "SamlRecords.listByOrganization: time first, then id, ascending" |
| 9 | `packages/saml/src/SamlRecords.ts:272-279` `newestFirst` | `listSpKeys` | desc, `id` | new: `packages/saml/test/RecordOrderPins.test.ts` "SamlRecords.listSpKeys: newest first, then id descending" |
| 10 | `packages/scim/src/ScimRecords.ts:174-182` `byCreation(rows, tieBreak)` | `listConnections` (tie `id`), `list` (tie `resourceId`), `linksOfResource` (tie `connectionId`) | asc | new: `packages/scim/test/RecordOrderPins.test.ts` "ScimRecords.listConnections: time first, then id, ascending", "ScimRecords.list orders a connection's links by (createdAt, resourceId)", "ScimRecords.linksOfResource orders by (createdAt, connectionId)" |
| 11 | `packages/webhooks/src/WebhookRecords.ts:314-321` `byCreation` | `listEndpoints`, `listEnabledEndpoints`, `listBySubject` | asc, `id` | new: `packages/webhooks/test/RecordOrderPins.test.ts` "WebhookRecords.listEndpoints: ...", "WebhookRecords.listEnabledEndpoints: ...", "WebhookRecords.listBySubject: ..." (each "time first, then id, ascending") |

All 11 sites are pinned; none of the five reused contract cases is a gap. Site 5's tie rests on the test clock not advancing between the three creates (the case asserts the order, not the timestamps), so a future harness that ticks the clock per call would weaken it silently; the Membership contract is unchanged in this phase.
