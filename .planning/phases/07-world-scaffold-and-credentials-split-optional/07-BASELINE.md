# Phase 7 Gate Baseline

**HEAD at capture:** `924538e4c6769e0e304d3c299c789e273eb7c0a6` (branch `architecture/deepening-batch-3`; phase base commit `ee8b80a1`, only `.planning/` changed since apart from the pin file). The tree is the phase base plus `packages/server/test/CredentialsSurface.test.ts` (commit `924538e4`, the Wave 0 pin of plan 07-01 Task 1).
**Captured:** 2026-11-15. Precondition met before the first gate: `git diff --name-only ee8b80a1 HEAD -- packages spec features examples docs .changeset knip.json scripts | grep -vc 'packages/server/test/CredentialsSurface\.test\.ts'` printed 0 (the pin file is the only path changed outside `.planning/`). `git log --format=%h -1 ee8b80a1` resolves.
**Toolchain:** node v26.13.0, pnpm 11.20.0, `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`
**Method:** each gate run on its own from the worktree root in the order below with `AWTHAQ_POSTGRES_URL` unset, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/` (its 0 s is an up-to-date incremental build). Output of every gate saved outside the repo. Wall times are not a signal (machine load varies). Every gate passed on its first run; no known intermittent fired.

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output), 0 `error TS` | 0 s |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 4 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 4 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 0 s (<1 s) |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 1 s |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 0 s (<1 s) |
| lint | `pnpm lint` | 0 | oxlint: 94 warnings, no errors: 87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`, none under `packages/` | 1 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1234 files` | 1 s |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 0 s (<1 s) |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 1 s |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | 14 s |
| unit | `pnpm test` | 0 | Test Files 429 passed, 6 skipped (435); Tests 6741 passed, 1 expected fail, 23 skipped (6765) | 144 s |
| coverage | `pnpm coverage` | 0 | Statements 91.81 (19854/21625), Branches 85.31 (7300/8557), Functions 87.13 (6448/7400), Lines 92.33 (18506/20043) (floors 89 / 83 / 84 / 90); same 429 + 6 skipped files, 6741 / 1 expected fail / 23 skipped tests | 67 s |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 54 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 70 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 47 s |

Versus the Phase 6 close (unit 428 files + 6 skipped, 6727 passed; bdd 39 files, 1580 / 44): unit is now 429 + 6 skipped files (the one new file is the pin `CredentialsSurface.test.ts`, +1 test) and 6741 passed, +14 over the Phase 6 close, of which 1 is the pin; the other 13 are run-to-run variation in what executes (no other `packages/` or `features/` file changed since the phase base), not a signal. bdd is unchanged at 39 files, 1580 passed, 44 skipped. Counts here are measured; the Phase 6 numbers are orientation only.

## Phase pins

CP, the Credentials importers on SQLite: the packages that import `@awthaq/server`'s `Credentials` (the server itself and the importers `qadi`, `web`, `jwt`, `api-key`, `next`, plus `test`). WP, the five feature files that run the Admin, Password and Domain Worlds, run in the `@awthaq/features` package (paths relative to it).

CP, full command:

```text
npx vitest run packages/server packages/qadi packages/web packages/jwt packages/api-key packages/next packages/test
```

WP, full command (the five files, in order):

```text
pnpm --filter @awthaq/features exec vitest run features/09-admin-and-impersonation/27-admin-impersonation.steps.test.ts features/05-authentication-methods/15-password.steps.test.ts features/01-contract-and-persistence/05-persistence-stratum.steps.test.ts features/02-domain/06-users-accounts.steps.test.ts features/02-domain/08-verification-tokens.steps.test.ts
```

The five files: `features/features/09-admin-and-impersonation/27-admin-impersonation.steps.test.ts` (AdminWorld), `features/features/05-authentication-methods/15-password.steps.test.ts` and `features/features/01-contract-and-persistence/05-persistence-stratum.steps.test.ts` (PasswordWorld), `features/features/02-domain/06-users-accounts.steps.test.ts` and `features/features/02-domain/08-verification-tokens.steps.test.ts` (DomainWorld).

| Pin | Command | Exit | Summary line printed | Wall time |
|-----|---------|------|----------------------|-----------|
| CP on SQLite (`AWTHAQ_POSTGRES_URL` unset) | the CP command above | 0 | Test Files 100 passed (100); Tests 1593 passed, 1 expected fail (1594) | 17 s |
| WP on SQLite | the WP command above | 0 | Test Files 5 passed (5); Tests 177 passed (177) | 12 s |

## Credentials surface snapshot

Taken on the untouched `packages/server/src/Credentials.ts`, before any `packages/server/src` edit, with the checker-based probe (a measuring instrument kept in the scratch directory, never in the repo): `TS_API_PATH="$PWD/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript" node surface-probe-07.cjs packages/server/src/Credentials.ts packages/server/tsconfig.src.json`, stdout in `07-CRED-SURFACE-BEFORE.txt`. Two runs gave identical bytes.

- 81 lines, 30 `## ` headings: 14 `[value]`, 12 `[type]`, 4 `[value+type]`; 0 `import(` texts.
- `shasum -a 256` = `efbf9b94e28774245a5630cdc2f9b1f3a17ccfe5b810211176af9ac31a7a9a1d` (equal to the planner's probe at `0b8c11f0`, so the tree is the planned one).
- Runtime pin: `packages/server/test/CredentialsSurface.test.ts` (commit `924538e4`, the only commit touching it, never edited afterwards): one `it` asserting `Object.keys(Credentials).sort()` equals the inline literal of the 18 value-bearing names (14 value plus 4 value+type), and one `export type { ... }` clause for the 12 type-only names. Green on the untouched file; a temporary one-name mutation of its own literal (`userTier` to `userTierX`) turned the case red (`Tests 1 failed (1)`) and was restored byte for byte.

## Leak-guard capture

`pnpm test:bdd` (SQLite, stdout and stderr in one file), then `grep '\[leak-guard\]' <bdd output> | sort`, saved as `07-LEAK-GUARD-BEFORE.txt`.

- 39 lines, every one ending `apps=0 sqlClients=0`; `shasum -a 256` = `cfce5d39bf62f8abe1124fe480485eeda359608aa20c9ccc03fd2165e209f338`.
- bdd counts re-measured at this HEAD: 39 files, 1580 passed, 44 skipped.
- The five lines of the three Worlds' feature files, verbatim:

```text
[leak-guard] features/01-contract-and-persistence/05-persistence-stratum.steps.test.ts apps=0 sqlClients=0
[leak-guard] features/02-domain/06-users-accounts.steps.test.ts apps=0 sqlClients=0
[leak-guard] features/02-domain/08-verification-tokens.steps.test.ts apps=0 sqlClients=0
[leak-guard] features/05-authentication-methods/15-password.steps.test.ts apps=0 sqlClients=0
[leak-guard] features/09-admin-and-impersonation/27-admin-impersonation.steps.test.ts apps=0 sqlClients=0
```

## knip (raw)

Full `pnpm knip` output (trailing whitespace trimmed), exit code 1: 39 `Unused files` rows, all under the untracked `.claude/` tree (the same count as the Phase 1 to 6 captures), then:

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

No unused exports, no unused dependencies, nothing under `packages/` other than the three `readme-quickstart.ts` unlisted-dependency rows. (Identical to the Phase 1 to 6 baselines.)

## Working tree at capture

`git status --short` (verbatim, taken after the gates, before the baseline commit):

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
?? .planning/phases/07-world-scaffold-and-credentials-split-optional/07-CRED-SURFACE-BEFORE.txt
?? .planning/phases/07-world-scaffold-and-credentials-split-optional/07-LEAK-GUARD-BEFORE.txt
```

`git diff --stat knip.json` (verbatim): empty (`knip.json` is unmodified at capture). The two `.planning/` modifications are the orchestrator's state files, not part of any gate.

## Postgres

Container `awthaq-p3-pg`, image Debian `postgres:16` (`PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`; `pg_isready`: `/var/run/postgresql:5432 - accepting connections`), `postgres://postgres:pw@localhost:55433/awthaq` (a throwaway local credential). This is the image CI uses (`.github/workflows/check.yml` runs `postgres:16`), not `scripts/test-pg.sh`'s alpine image. `AWTHAQ_POSTGRES_URL` was passed explicitly on each command. **The container was recreated with `--shm-size=1g` (empty database) before every recorded full run** (`pg-fresh.sh`), and `npx tsc -b tsconfig.json` ran first each time (exit 0, 0 to 1 s). Tree: HEAD `a3f92d65` equivalent to the capture tree (the pin plus `.planning/` files only).

| Run | Command | Exit | Summary line printed | Failing tests | Wall time |
|-----|---------|------|----------------------|---------------|-----------|
| full unit, run 1 | `pnpm test` | 1 | Test Files 2 failed, 433 passed (435); Tests 3 failed, 6781 passed, 1 expected fail, 1 skipped (6786) | (a) `packages/admin/test/Contract.test.ts` ... `ImpersonationRecords (sql)` "create [atomic]: an interrupted create leaves its row and its link together, or neither" (5007 ms timeout); (b) the same file, "create [race]: 8 creates racing verifyChain never report a break" (5003 ms timeout); (c) `packages/organization/test/TenantMiddleware.test.ts` "Organization.tenantMiddlewareWithRls: the database is the backstop (real Postgres) > a request under tenant A that runs an unfiltered query sees only A's organization-keyed rows" (`Test timed out in 5000ms`, `InterruptError` logged) | 218 s |
| the run-1 file alone, 3 runs | `npx vitest run packages/organization/test/TenantMiddleware.test.ts` (Postgres URL prefixed) | 0, 0, 0 | Test Files 1 passed (1); Tests 7 passed (7), each run | none | each under 10 s |
| full unit, run 2 | `pnpm test` (fresh container) | 1 | Test Files 2 failed, 433 passed (435); Tests 2 failed, 6782 passed, 1 expected fail, 1 skipped (6786) | (d) `packages/passkey/test/Contract.test.ts` `ChallengeStore (sql)` "consume [atomic]: false for any other value, a tampered one included" (`expected true to be false`, known intermittent 1, the sql variant); (e) `packages/test/test/StoreContract.sql.test.ts` "StoreContract: RateLimiterStore (SQL) > the sweeper deletes expired rows" (`1 !== 0` at `packages/test/src/internal/storeContract/rateLimiterStore.ts:94`) | 203 s |
| the run-2 files alone, 3 runs | `npx vitest run packages/test/test/StoreContract.sql.test.ts packages/passkey/test/Contract.test.ts` (Postgres URL prefixed) | 0, 0, 0 | Test Files 2 passed (2); Tests 219 passed (219), each run | none | each under 10 s |
| full unit, run 3 (the baseline unit row) | `pnpm test` (fresh container) | 0 | Test Files 435 passed (435); Tests 6784 passed, 1 expected fail, 1 skipped (6786) | none | 101 s |
| full bdd | `pnpm test:bdd` (fresh container) | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | none | 13 s |

Failing-test list for the Postgres full-suite record: empty on run 3 (the unit baseline) and on the bdd run. Every run is listed. Of the five distinct failures across runs 1 and 2: (a), (b) and (d) are known intermittents 3 and 1. **(c) and (e) are not on the known list.** Both are timing-dependent: (c) is a `Test timed out in 5000ms` of a test in the file that holds known intermittent 2 (a different case of `TenantMiddleware.test.ts`), (e) is a sweeper assertion that depends on the sweeper fiber having run before a `TestClock.adjust` (the one test in the file that does); both passed alone 3 of 3 and in the third full run, no source changed between runs. They are recorded here as candidate additions for the known-intermittent list (orchestrator's decision), not fixed in this phase. Run 3 (green) is the third full run, so no further re-run was spent.

Postgres versus SQLite: unit on Postgres 435 files, 6784 passed, 1 skipped, against 429 files + 6 skipped and 6741 passed, 23 skipped on SQLite (the Postgres-only files stop skipping and their cases run); bdd identical (39 files, 1580 passed, 44 skipped) on both. Log symptoms: 0 matches for `server closed|segfault|terminated unexpectedly|shared memory` across the four Postgres logs (`--shm-size=1g`).

Leak-guard on Postgres: the five `[leak-guard]` lines of the three Worlds' feature files, and in fact all 39 sorted `[leak-guard]` lines, equal `07-LEAK-GUARD-BEFORE.txt` byte for byte (`diff` empty): every line `apps=0 sqlClients=0`.

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

`git diff --name-only ee8b80a1 HEAD -- packages spec features examples docs .changeset knip.json scripts | grep -vc 'packages/server/test/CredentialsSurface\.test\.ts'` re-checked after the Postgres runs: 0.

## Known intermittents

1. `packages/passkey/test/Contract.test.ts` > `runPluginContractTests` > `RecordsContract: passkey` > `RecordsContract: awthaq/passkey/records/ChallengeStore (memory or sql variant)` > `consume [atomic]: false for any other value, a tampered one included`. **Fired in this capture** in Postgres full unit run 2 (the sql variant; the SQLite legs did not fire it).
2. `packages/organization/test/TenantMiddleware.test.ts` > `... a suspended organization still resolves (the plugin's own gate refuses it)`. Did not fire in this capture.
3. The admin `ImpersonationRecords (sql)` pair: `create [atomic]: an interrupted create leaves its row and its link together, or neither` and `create [race]: 8 creates racing verifyChain never report a break` (`Test timed out in 5000ms`; fire only in a full-suite Postgres run, never alone). **Fired in this capture** in Postgres full unit run 1 (both cases, 5 s timeouts).
4. **Candidates found in this capture, not yet on the list (orchestrator's decision):** `packages/organization/test/TenantMiddleware.test.ts` "Organization.tenantMiddlewareWithRls: the database is the backstop (real Postgres) > a request under tenant A that runs an unfiltered query sees only A's organization-keyed rows" (5 s timeout, Postgres run 1) and `packages/test/test/StoreContract.sql.test.ts` "StoreContract: RateLimiterStore (SQL) > the sweeper deletes expired rows" (`1 !== 0`, Postgres run 2). Each passed alone 3 of 3 and in the next full run; see "Postgres".

Rule for later plans: a command whose only failures are these cases is re-run (at most twice) and every run is recorded; any other failure is a real regression. The Postgres container is recreated with `pg-fresh.sh` before each full Postgres run. Runs here: every SQLite gate ran once and passed (no re-run needed); Postgres full unit ran three times (run 1 failed on 3 and run 2 on 2 intermittent-or-candidate cases, run 3 green), bdd once (green).

## Expected deltas

The phase's planned changes, so a delta is not read as drift:

- bdd: Test Files +1 and Tests passed +1 from the new classification guard (`features/features/_guard/world-table.steps.test.ts`); skipped unchanged (44).
- unit counts unchanged after this baseline (the new pin is already counted here: 429 + 6 skipped files, 6741 passed).
- `pnpm format:check` file count grows by 8 over 1234 (five internal modules `packages/server/src/internal/{PrincipalResolver,CredentialResolvers,Presented,Resolution,Scopes}.ts`, `EventCapture.ts`, `EventCapture.types.ts`, the guard test), recorded as measured at close.

## Phase-close comparison rule

Every gate exits as it did here, and the comparison is made on a tree where `git diff --stat knip.json` is empty.

1. Every gate exits as here: all 0 except `pnpm knip`, which exits 1 only for the pre-existing findings above.
2. Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `FAIL 0` and `SKIP 0`, with PASS at or above 32 (this capture).
3. `pnpm check:error-tags` and `pnpm check:contract-tests` print the same numbers as here (163 / 137, 21 plugin classes), and `pnpm check:readmes`, `pnpm circular` and `pnpm check:transactions` exit 0.
4. knip's filtered output gains nothing: only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, no row under `packages/` besides them; `git diff --stat knip.json` stays empty.
5. Full unit and full bdd pass on Postgres with the failing list not growing (see "Postgres" below for the list at this HEAD; the three known intermittents each allow up to two recorded re-runs); record again as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)". CP and WP pass on SQLite as recorded in "Phase pins".
6. No new dependency: `git diff --stat ee8b80a1 HEAD -- 'packages/*/package.json' features/package.json 'examples/*/package.json' pnpm-lock.yaml` prints nothing.
7. The sorted `[leak-guard]` lines are identical to `07-LEAK-GUARD-BEFORE.txt`, apart from the single line of the new guard file (`features/_guard/world-table.steps.test.ts apps=0 sqlClients=0`); every line still ends `apps=0 sqlClients=0`.
8. The Credentials export-surface probe, re-run on the split `Credentials.ts` with the same script and tsconfig, diffs empty against `07-CRED-SURFACE-BEFORE.txt` (or differs only as the plan that does the split justifies), and `CredentialsSurface.test.ts` has exactly one commit since the phase base.

## CRED-01 closure (plan 07-03)

HEAD `29b590b6` (the Task 2 commit; the Task 1 commit is `89702458`), 2026-11-15.

**Layout (lines).** Before (`0b8c11f0`): `Credentials.ts` 678. After: `Credentials.ts` 52 (header comment, two comment lines, 30 named re-exports), `internal/PrincipalResolver.ts` 86, `internal/CredentialResolvers.ts` 163, `internal/Presented.ts` 97, `internal/Resolution.ts` 255, `internal/Scopes.ts` 107.

**Surface proof.** `07-CRED-SURFACE-BEFORE.txt` and `07-CRED-SURFACE-AFTER.txt`: 81 lines, 30 `## ` headings, sha256 `efbf9b94e28774245a5630cdc2f9b1f3a17ccfe5b810211176af9ac31a7a9a1d` for both; `diff` prints 0 lines; the live probe over the final facade diffs 0 lines against BEFORE. The runtime-name pin `CredentialsSurface.test.ts` is green and has exactly one commit since the phase base (`git log --oneline ee8b80a1..HEAD -- packages/server/test/CredentialsSurface.test.ts | wc -l` prints 1).

**Verbatim proof.** The VM awk check over the facade and the five internal modules prints `OK` (n > 500 original lines, none lost or changed apart from imports and `export`-prefixed twins, no new code line). Its stray-line mutation was recorded in plan 07-02 (`FAIL bad=0 new=1` with `const stray = 1;` appended to `PrincipalResolver.ts`, `OK` once removed). The facade declaration census is 0 (was 45), `^import ` count 0 (was 19), `export *` 0. The divider comments `the seam: a scope` and `the two scopes` moved with their code so the check loses no original line.

**Probe mutation.** `Source` was deleted from the `export type { }` clause of `./internal/Presented.ts` in `Credentials.ts` (then restored from a byte copy; `git diff --stat packages/server/src/Credentials.ts` prints nothing afterwards). Outcomes: `npx tsc -b tsconfig.json` 0 errors (nothing outside the file uses `Source`); `CredentialsSurface.test.ts` green (1 test: a type name is not a runtime key); the probe diff is non-empty and names the missing heading (`> ## Source [type]` with its two members, 4 lines). So the probe diff, not the pin, guards the type names.

**Single-flight.** `grep -c 'new WeakMap'`: 3 in `internal/Resolution.ts`, 3 across `packages/server/src`, 0 in `Credentials.ts`. `sessionMemo`, `claimMemo`, `outages` and `once` are file-private `const`s in `Resolution.ts` (4 matches); `Failure` and `annotatePrincipal` are private as well. No `internal/` file imports `../Credentials`.

**Consumers.** CP on SQLite (`AWTHAQ_POSTGRES_URL` unset): Test Files 100 passed (100); Tests 1593 passed, 1 expected fail (1594), equal to the "Phase pins" CP row; the new internal files add no test file. `git diff --name-only ee8b80a1 HEAD -- packages/api-key packages/jwt packages/qadi packages/web packages/next packages/test features examples spec docs .changeset knip.json | grep -c .` prints 0; manifests and lockfile diff prints 0. The only non-`.planning/` paths changed since the phase base are `Credentials.ts`, the five internal modules and `CredentialsSurface.test.ts`.

**Gates.** `npx tsc -b tsconfig.json` 0 errors; `npx tsc -p tsconfig.test.json` 0 errors; `pnpm circular` exit 0; `pnpm lint` exit 0 (baseline warnings only); `pnpm format:check` clean. `pnpm knip` exit 1 as at baseline: filtered output is the banner, `Unused files (39)` (all `.claude/`), `Unlisted dependencies (3)` with the three `packages/sql/test/fixtures/readme-quickstart.ts` rows and ELIFECYCLE; 0 extra rows; `git diff --stat knip.json` empty.

**Decisions.** No ADR edit: ADR-EA-042 pins a module named `Credentials` in `@awthaq/server` with its members and behaviours, not a path or file layout. No spec or docs edit: no spec or docs line cites `packages/server/src/Credentials.ts` (`grep -rl` over `spec` and `docs` prints nothing). no changeset: `@awthaq/server` exports only `.`, the public surface diff is empty; the published `lib/Credentials.d.ts` text changes to re-export lines but nothing a consumer can import changes (the Phase 2 split of TestAuth recorded the same decision).

### Path allowlist

Every line of `git diff --name-only ee8b80a1 HEAD` must match:

```text
^(\.planning/|features/step-definitions/shared/EventCapture(\.types)?\.ts$|features/features/_guard/world-table\.steps\.test\.ts$|features/step-definitions/(AdminWorld|PasswordWorld|DomainWorld)\.ts$|packages/server/src/Credentials\.ts$|packages/server/src/internal/(PrincipalResolver|CredentialResolvers|Presented|Resolution|Scopes)\.ts$|packages/server/test/CredentialsSurface\.test\.ts$)
```

Plus the empty-diff checks: `git diff --name-only ee8b80a1 HEAD -- packages/test`, the importer packages (`packages/api-key`, `packages/jwt`, `packages/qadi`, `packages/web`, `packages/next`), every other `packages/*/src`, `packages/*/package.json`, `pnpm-lock.yaml`, `knip.json`, `.changeset`, `spec`, `docs`, `examples` print nothing; the 28 Worlds other than Admin, Password and Domain have an empty diff. No changeset, spec, docs, ADR or package.json change is planned (D-08: a pure internal split and a test-suite helper change no `@awthaq/server` output).

## World scaffold: helper and Admin adoption (plan 07-04)

HEAD `c34c34e3`, 2026-11-15, SQLite/memory (`AWTHAQ_POSTGRES_URL` unset).

**Helper shape (as built).** `features/step-definitions/shared/EventCapture.ts`, 44 lines: the overloaded form compiled and linted cleanly on the first probe (no fallback to two exports, no cast). Two overload declarations (`captureEvents(into)` for a `PublishedAny` Ref; `captureEvents(into, keep)` with a type predicate and a Ref of the narrowed type) over one generic implementation whose `keep` defaults to the accept-all predicate `(_event): _event is E => true`. Result type `Layer.Layer<never, never, AuthEvents.AuthEvents>`; imports only `AuthEvents` from `@awthaq/core` and `Effect`, `Layer`, `Ref`, `Stream`. `OrganizationWorld` stays inline (its `subscribe` registration is recorded in the doc comment).

**Pin (`EventCapture.types.ts`, no gate marker).** Claim 1 `needsOnlyAuthEvents` (exact requirement, both directions); claim 2 `stillClosed` (`Layer.Services` of `TestAuth.layer(Auth.make([Password.Password]), { services: Password.config({}) + TestAuth.httpClient.noBreach, taps: helper })` extends `never`; a plain `Layer<unknown, unknown, never>` assignment is rejected by variance, so the `never` form is the closed-composition check); claim 3 `foreignTapDoesNotLaunch` (`@ts-expect-error` on `Layer.launch` over the same composition with `Layer.mergeAll(helper, <undeclared HookPoint tap>)`). The file is checked by `npx tsc -b tsconfig.json` (the `features` project), not only by `tsconfig.test.json`.

**Recorded mutations (each restored from a byte copy, `cmp` clean).**
- Helper implementation reads `Sessions.Sessions`: tsc red inside `EventCapture.ts` (TS2375, the explicit `Capture` annotation rejects the wider requirement); the pin is not what catches this, the annotation is.
- Declared requirement widened to `AuthEvents | Sessions` or `AuthEvents | Mailer`: claim 1 red; claim 2 stays green, because the harness provides `Sessions` and `Mailer`.
- Declared requirement widened to `AuthEvents | Extra` (a service no harness provides): claim 1 and claim 2 both red (TS2322 at `needsOnlyAuthEvents` and `stillClosed`).
- Claim 3 without its `@ts-expect-error` line: TS2379 (`Effect<never, never, Undeclared>` not assignable to `Effect<never, never, never>`).
After each restore `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json` is clean.

**Admin.** The inline subscriber block is gone (`grep -c 'authEvents.stream' AdminWorld.ts` 0); `taps: captureEvents(events, AuthEvents.is(worldEvents))` sits at the same position; `Stream` was the only import left unused. Admin feature file: 1 file, 37 passed (37), `[leak-guard] ... apps=0 sqlClients=0`.

ADOPTION-DELTA world=AdminWorld removed=22 added=3

No size win is claimed: the helper is kept for locality of the race fix; the net line count is recorded after plan 07-05.

**bdd and gates.** `pnpm test:bdd` exit 0: Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624), equal to the bdd row; the sorted `[leak-guard]` lines diff against `07-LEAK-GUARD-BEFORE.txt` prints 0 lines. `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` 0 errors; `pnpm lint` exit 0 (baseline warnings only, none in the new or edited files); `pnpm format:check` clean; `pnpm circular` exit 0; `pnpm knip` exit 1 as at baseline (39 `.claude/` unused files, the 3 `readme-quickstart.ts` rows, ELIFECYCLE). `git diff --name-only ee8b80a1 HEAD -- packages/test features/step-definitions/OrganizationWorld.ts` prints nothing.

## World scaffold: adoption (plan 07-05)

HEAD `1aea6d49` (the Password adoption is `5297eb93`, the Domain adoption `1aea6d49`), 2026-11-15. Admin, Password and Domain are now the three scaffolded Worlds; no inline `authEvents.stream` is left in any of them (`grep -c` 0 each).

**Deltas (`git diff --numstat ee8b80a1 HEAD`).**

ADOPTION-DELTA world=AdminWorld removed=22 added=3
ADOPTION-DELTA world=PasswordWorld removed=14 added=2
ADOPTION-DELTA world=DomainWorld removed=14 added=2

Helper `EventCapture.ts`: 44 lines. Pin `EventCapture.types.ts`: 43 lines (additive, not counted).

NET removed 50, added 7, helper 44: 50 - 7 - 44 = -1 (the three Worlds shrink by 43 lines; the helper costs 44, so the code base is one line larger, 51 added against 50 removed).

The net is not negative in size, so no size win is claimed: the helper is kept for locality of the reproduced-race fix (`startImmediately`: one copy to read and fix instead of three by reference), not for size. `OrganizationWorld` keeps its own `subscribe` layer.

**Adopters.** Both calls are the no-predicate form at the old position inside the same `Layer.mergeAll`: `captureEvents(events)` last in `PasswordWorld`'s `common.services`, `captureEvents(probes.events)` last in `DomainWorld`'s `services` (the `records: "sql"` composition). `Stream` was the only import left unused in each. Password files (`15-password`, `05-persistence-stratum`): 2 files, 72 passed (72); Domain files (`06-users-accounts`, `08-verification-tokens`): 2 files, 68 passed (68); every `[leak-guard]` line `apps=0 sqlClients=0`.

**Recorded mutations on the scaffolded DomainWorld (each restored from a byte copy; `git diff --stat` empty, tsc green afterwards).**
- (a) `NoBreachHttpClient` omitted from the `services` merge: `npx tsc -p tsconfig.test.json` red at `DomainWorld.ts(280,39)`, the `TestAuth.serve(appLayer)` call: TS2379 ("Type 'HttpClient' is not assignable to type 'never'") and TS377034 ("Missing 'HttpClient' in the expected Layer context"), plus TS6133 for the now-unused `NoBreachHttpClient` constant. Same codes as measured at `0b8c11f0` on the unscaffolded World.
- (b) `Password.Password` dropped from the `Auth.make([Profile, Password.Password])` tuple: tsc stays green, as found (and as the planner measured). It contradicts the research's suggested mutation.
- The surviving compile-time gate in a scaffolded World is therefore a composed plugin's unmet requirement at `TestAuth.serve`: omitting a plugin's required service is red, omitting a plugin that nothing else forces is not. ROADMAP criterion 2's "omitting a plugin" reads that way.

**SQLite.** `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` 0 errors (only the pre-existing `TestingHarnessSteps.ts` TS377149 warnings); full `pnpm test:bdd` exit 0: Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624), equal to the bdd row; the sorted `[leak-guard]` lines diff against `07-LEAK-GUARD-BEFORE.txt` prints 0 lines. `pnpm lint` exit 0 (baseline warnings, none in `PasswordWorld.ts` or `DomainWorld.ts`), `pnpm format:check` clean, `pnpm circular` exit 0, `pnpm knip` exit 1 as at baseline (39 `.claude/` unused files, the 3 `readme-quickstart.ts` rows, ELIFECYCLE).

**Postgres, targeted (the three Worlds' feature files).** Container recreated with `bash pg-fresh.sh` first (Debian `postgres:16`, `PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1)`), `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` passed explicitly, one run, no intermittent fired.

| Command | Exit | Test Files | Tests | Leak-guard |
|---------|------|------------|-------|------------|
| `pnpm --filter @awthaq/features exec vitest run` over `27-admin-impersonation`, `15-password`, `05-persistence-stratum`, `06-users-accounts`, `08-verification-tokens` | 0 | 5 passed (5) | 177 passed (177) (37 + 72 + 68, equal to the SQLite counts) | all five `apps=0 sqlClients=0` |

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

The full Postgres bdd and unit legs belong to plan 07-07.

**Integrity (empty diffs since `ee8b80a1`).** The 28 Worlds other than Admin, Password and Domain: `git diff --name-only ... | grep -E 'World\.ts$' | grep -vE '/(AdminWorld|PasswordWorld|DomainWorld)\.ts$' | grep -c .` prints 0. The five hand-wired Worlds (Authentication, ContractStratum, Csrf, QadiBridge, Tenancy) and `OrganizationWorld`: 0 lines. `packages/test`: 0 lines.

## Phase close

HEAD `6e747cd8` at the start of the structural close (the 07-06 completion commit; no `packages`, `features`, `spec`, `docs`, `examples` or `.changeset` path is modified in the working tree: `git status --porcelain -- packages features spec docs examples .changeset | grep -c .` prints 0), 2026-11-15. Phase base `ee8b80a1`. `npx tsc -b tsconfig.json` ran first: exit 0, no output.

### Census

Every command run from the worktree root; "planning" is the value at `0b8c11f0`.

| Check | Command | Planning | Now | Expected | Verdict |
|-------|---------|---------:|----:|---------:|---------|
| inline stream subscriptions in the three adopters | `cat features/step-definitions/AdminWorld.ts features/step-definitions/PasswordWorld.ts features/step-definitions/DomainWorld.ts \| grep -c 'authEvents.stream'` | 3 | 0 | 0 | MET |
| Worlds importing the scaffold | `grep -l 'shared/EventCapture' features/step-definitions/*World.ts \| grep -c .` | 0 | 3 | 3 | MET |
| Worlds classified | `ls features/step-definitions/*World.ts \| wc -l` | 31 | 31 | 31 (guard and table each classify 31) | MET |
| bdd test files | `find features -name '*.steps.test.ts' \| wc -l` | 39 | 40 | 40 | MET |
| OrganizationWorld keeps its own layer | `grep -c 'Layer.effectDiscard' features/step-definitions/OrganizationWorld.ts` | 1 | 1 | 1 | MET |
| Credentials.ts declarations | `grep -cE '^(export )?((const\|class\|function\|interface) [A-Za-z]\|type [A-Za-z_]+[ <=])' packages/server/src/Credentials.ts` | 45 | 0 | 0 | MET |
| internal modules | `ls packages/server/src/internal \| grep -cE '^(PrincipalResolver\|CredentialResolvers\|Presented\|Resolution\|Scopes)\.ts$'` | 0 | 5 | 5 | MET |
| memo tables in Resolution.ts | `grep -c 'new WeakMap' packages/server/src/internal/Resolution.ts` | error (no file) | 3 | 3 | MET |
| memo tables left in Credentials.ts | `grep -c 'new WeakMap' packages/server/src/Credentials.ts` | 3 | 0 | 0 | MET |
| non-planning paths changed since the phase base | `git diff --name-only ee8b80a1 HEAD \| grep -vc '^\.planning/'` (run as `grep -v '^\.planning/'`, 13 lines) | 0 | 13 | 13 | MET |

Line counts (`wc -l`): `Credentials.ts` 678 before, 52 now (the facade); `internal/PrincipalResolver.ts` 86, `internal/CredentialResolvers.ts` 163, `internal/Presented.ts` 97, `internal/Resolution.ts` 255, `internal/Scopes.ts` 107 (708 lines across the five modules); `shared/EventCapture.ts` 44, `shared/EventCapture.types.ts` 43.

### WORLD-01 closure

The requirement is read as the orchestrator aligned it in ROADMAP and REQUIREMENTS: the scaffold composes with `TestAuth.layer` without re-wrapping it (D-01, D-09).

- Three Worlds scaffolded, each with its adoption line (`git diff --numstat ee8b80a1 HEAD`):

  ```text
  ADOPTION-DELTA world=AdminWorld removed=22 added=3
  ADOPTION-DELTA world=PasswordWorld removed=14 added=2
  ADOPTION-DELTA world=DomainWorld removed=14 added=2
  ```

  Census above: 0 inline `authEvents.stream` in the three Worlds (was 3); exactly the three import `shared/EventCapture` (was 0).
- NET, as measured: the adopters removed 50 lines and added 7; the helper `EventCapture.ts` is 44 lines, so 51 lines were added against 50 removed: a net of +1 line in the code base (50 - 7 - 44 = -1 saved). The pin `EventCapture.types.ts` (43 lines) is counted separately and is additive. Counting the pin the net is +44. No size win is claimed: the helper is kept for locality of the reproduced lost-publish race fix (`startImmediately`: one copy to read and fix instead of three), not for size.
- The two roadmap pieces not pursued, with their measured reason from "The honest record" of `07-WORLD-TABLE.md`: `lazyApp` is one call to the shared `TestAuth.lazyApp` primitive per World, and `TestClock` is already an option of `TestAuth` (`serve({ testClock })`, `lazyApp(..., { alignStepClock })`); nothing repeats, so the deletion test fails and only the events subscriber (three Worlds) repeats.
- The table and the guard: `07-WORLD-TABLE.md` (31 rows: 3 scaffolded, 5 hand-wired, 23 no-tail) and `features/features/_guard/world-table.steps.test.ts` (one test, four assertions, inline map of the same 31, shown red for an unclassified World and for a misclassified one in plan 07-06). The guard file is the 40th bdd test file.
- OrganizationWorld stays inline (`Layer.effectDiscard` 1, a `subscribe` registration with different semantics than the scaffold's `stream`, D-11).

### WORLD-02 closure

- The five hand-wired Worlds (Authentication, ContractStratum, Csrf, QadiBridge, Tenancy) plus `OrganizationWorld`: `git diff --name-only ee8b80a1 HEAD -- <the six files> | grep -c .` prints 0. Every World other than the three adopters: `git diff --name-only ee8b80a1 HEAD | grep -E 'World\.ts$' | grep -vE '/(AdminWorld|PasswordWorld|DomainWorld)\.ts$' | grep -c .` prints 0 (so the 23 no-tail Worlds are untouched as well).
- LeakGuard accounting unchanged: `features/step-definitions/shared/LeakGuard.ts` is in the empty-diff command (`git diff --name-only ee8b80a1 HEAD -- packages/test ... features/step-definitions/shared/LeakGuard.ts ... | grep -c .` prints 0). Sorted `[leak-guard]` lines: compared in the gate sections below (the capture has 39 lines, the guard adds one).
- The compile-error gate is kept, with its evidence: the existing gate files compile and the bdd suite is green (gate sections below); the plan 07-04 type pin `EventCapture.types.ts` (claims 1 to 3 and the recorded mutations: a widened requirement turns claim 1 and, for an unprovided service, claim 2 red; a foreign tap fails to launch); the plan 07-05 mutation (a) on the scaffolded DomainWorld: `NoBreachHttpClient` omitted from the services merge is red at `TestAuth.serve(appLayer)` (TS2379 and TS377034). The surviving gate is a composed plugin's unmet requirement at `TestAuth.serve`: mutation (b), dropping `Password.Password` from the `Auth.make` tuple, stays green (see flag 2).
- No second composer: `git diff --name-only ee8b80a1 HEAD -- packages/test` prints nothing, and the helper imports only `AuthEvents` from `@awthaq/core` and `effect` modules (`grep -nE '^import' EventCapture.ts`: lines 17 to 21); `TestAuth`, `Auth.make` and host names appear only in its header comment (line 11, "What it does not touch").

### CRED-01 closure

- Equal surface snapshots: `diff 07-CRED-SURFACE-BEFORE.txt 07-CRED-SURFACE-AFTER.txt | wc -l` prints 0; `shasum -a 256` of both is `efbf9b94e28774245a5630cdc2f9b1f3a17ccfe5b810211176af9ac31a7a9a1d`. Each snapshot was committed once (`07-CRED-SURFACE-BEFORE.txt` in `a3f92d65`, `07-CRED-SURFACE-AFTER.txt` in `29b590b6`; `07-LEAK-GUARD-BEFORE.txt` in `a3f92d65`).
- The runtime-name pin has exactly one commit: `git log --format=%h ee8b80a1..HEAD -- packages/server/test/CredentialsSurface.test.ts` prints `924538e4`.
- VM output: the verbatim check over the facade plus the five internal modules printed `OK` in plan 07-03 and its stray-line mutation printed `FAIL bad=0 new=1` in plan 07-02 (see "CRED-01 closure (plan 07-03)").
- Single-flight table placement: `Credentials.ts` has 0 `new WeakMap`, `internal/Resolution.ts` has 3 (`sessionMemo`, `claimMemo`, `outages`, with `once`, are file-private there); the facade is 52 lines (30 named re-exports, 0 declarations, was 45), and no `internal/` file imports `../Credentials`.
- Importers unedited: `git diff --name-only ee8b80a1 HEAD -- packages/api-key packages/jwt packages/qadi packages/web packages/next ... | grep -c .` prints 0 (the empty-diff command above, together with `packages/test`).
- No ADR, spec, docs or changeset change: `git diff --name-only ee8b80a1 HEAD -- spec docs .changeset` is inside that same empty-diff command (prints 0); ADR-EA-042 pins a module named `Credentials` in `@awthaq/server`, not a file layout, and no changeset is needed because `@awthaq/server` exports only `.` with an empty surface diff (decision recorded in plan 07-03).

### Path allowlist

The regex of "Path allowlist" above: `git diff --name-only ee8b80a1 HEAD | grep -vE '<regex>' | grep -c .` prints 0 (residue 0). The 13 non-planning paths:

```text
features/features/_guard/world-table.steps.test.ts
features/step-definitions/AdminWorld.ts
features/step-definitions/DomainWorld.ts
features/step-definitions/PasswordWorld.ts
features/step-definitions/shared/EventCapture.ts
features/step-definitions/shared/EventCapture.types.ts
packages/server/src/Credentials.ts
packages/server/src/internal/CredentialResolvers.ts
packages/server/src/internal/Presented.ts
packages/server/src/internal/PrincipalResolver.ts
packages/server/src/internal/Resolution.ts
packages/server/src/internal/Scopes.ts
packages/server/test/CredentialsSurface.test.ts
```

### Integrity

- `git diff --name-only ee8b80a1 HEAD -- packages/test packages/api-key packages/jwt packages/qadi packages/web packages/next features/step-definitions/shared/LeakGuard.ts spec docs examples .changeset knip.json features/package.json pnpm-lock.yaml | grep -c .`: 0.
- `git diff --stat ee8b80a1 HEAD -- 'packages/*/package.json' 'examples/*/package.json' | grep -c .`: 0.
- Hand-wired Worlds and OrganizationWorld: 0; every World other than the three adopters: 0.
- `CredentialsSurface.test.ts` commits since the phase base: 1 (`924538e4`); surface snapshot `diff` lines: 0.

### Margins

Stated as measured, not re-judged.

- Helper NET (plan 07-05): the three adopters removed 50 and added 7, the helper is 44 lines, so +1 line in the code base without the 43-line pin (51 added against 50 removed) and +44 with it. Kept for locality, not for size.
- Credentials split: `Credentials.ts` 678 lines became a 52-line facade plus five internal modules of 86 + 163 + 97 + 255 + 107 = 708 lines (760 lines in total, +82 over the original, the cost of five module headers and import blocks; the code lines moved verbatim).
- Added files: `EventCapture.ts`, `EventCapture.types.ts`, the guard test `world-table.steps.test.ts`, the five internal modules (`format:check` file count +8 is expected from these), plus the pin `CredentialsSurface.test.ts` (already in the baseline counts).
- Fallbacks: none. `captureEvents` compiled and linted as overloads on the first probe (plan 07-04), no two-export fallback and no cast.
- Cross-file exports beyond `resolveClaimed` (recorded in plan 07-02, `export const resolveClaimed` in `internal/CredentialResolvers.ts`): none in plan 07-03.

### Flags for the milestone report

Recorded as findings; ROADMAP.md and REQUIREMENTS.md are not edited here.

1. WORLD-01 and ROADMAP criterion 1 say the scaffold "wraps `TestAuth.layer`" and supplies `lazyApp`, `TestClock` and capture layers; per D-09 the shipped scaffold composes with `TestAuth.layer` without re-wrapping it and supplies the capture layer only (`lazyApp` and `TestClock` are single calls or options of `TestAuth`, nothing repeated to delete).
2. ROADMAP criterion 2's "omitting a plugin is still a compile error": dropping `Password.Password` from the `Auth.make` tuple of the scaffolded DomainWorld compiled green (measured in plan 07-05); the surviving compile-time gate is a composed plugin's unmet requirement at `TestAuth.serve` (omitting `NoBreachHttpClient` is red).
3. The classification table has three classes (scaffolded 3, hand-wired 5, no-tail 23), not two.
4. The Postgres legs ran locally on the CI image (Debian `postgres:16`) and CI confirmation is open (no git remote).
5. The `captureEvents` shape actually built is overloads (`captureEvents(into)` and `captureEvents(into, keep)` with a type predicate) over one generic implementation; no two-export fallback.
6. No changeset, spec, docs or ADR change in the phase (the path allowlist has no such path).
7. From plan 07-01: two unlisted timing flakes fired on the Postgres full unit runs and are admitted as known intermittents: organization `TenantMiddleware` "a request under tenant A that runs an unfiltered query sees only A's organization-keyed rows" and `packages/test` `StoreContract.sql` "RateLimiterStore (SQL) > the sweeper deletes expired rows".

### Gates on SQLite

HEAD `8aca93c9` (the structural-close commit; the tree under `packages` and `features` is unchanged since `6e747cd8`), `AWTHAQ_POSTGRES_URL` unset, each gate its own command in baseline order, wall time with `date +%s`, full output in the scratch directory. `git diff --stat knip.json` prints nothing.

| Gate | Command | Exit | Summary line printed | Wall | Baseline | Verdict |
|------|---------|------|----------------------|------|----------|---------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | no output, 0 `error TS` | 1 s | 0 | MET |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; the same 2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts` (851, 853) | 4 s | 0 | MET |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 3 s | 0 | MET |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 1 s | same | MET |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 0 s | same | MET |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 1 s | same | MET |
| lint | `pnpm lint` | 0 | oxlint: 94 warnings, no errors: 87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`, none under `packages/` and none in an edited or added file | 0 s | 94, same split | MET |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1242 files` | 1 s | 1234 files | MET (+8, the expected delta) |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 0 s | same | MET |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 1 s | same | MET |
| bdd | `pnpm test:bdd` | 0 | Test Files 40 passed (40); Tests 1581 passed, 44 skipped (1625) | 10 s | 39 / 1580 / 44 | MET (+1 file, +1 passed, skipped unchanged) |
| unit, run 1 | `pnpm test` | 1 | Test Files 1 failed, 428 passed, 6 skipped (435); Tests 1 failed, 6740 passed, 1 expected fail, 23 skipped (6765) | 49 s | | known intermittent 1, see below |
| unit, re-run 1 | `pnpm test` | 0 | Test Files 429 passed, 6 skipped (435); Tests 6741 passed, 1 expected fail, 23 skipped (6765) | 139 s | 429 + 6 / 6741 / 1 / 23 | MET (equal) |
| coverage | `pnpm coverage` | 0 | Statements 91.81 (19854/21625), Branches 85.31 (7300/8557), Functions 87.13 (6448/7400), Lines 92.33 (18506/20043) (floors 89 / 83 / 84 / 90); 429 + 6 skipped files, 6741 / 1 expected fail / 23 skipped tests | 58 s | the same figures | MET (equal) |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 87 s | PASS 32 | MET |
| knip | `pnpm knip` | 1 (pre-existing) | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 69 s | exit 1, same | MET |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for 30 packages, 0 other | 44 s | 30 PASS | MET |
| CP on SQLite | `npx vitest run packages/server packages/qadi packages/web packages/jwt packages/api-key packages/next packages/test` | 0 | Test Files 100 passed (100); Tests 1593 passed, 1 expected fail (1594) | 22 s | 100 / 1593 / 1 | MET (equal) |
| WP on SQLite | the WP command of "Phase pins" plus `features/_guard/world-table.steps.test.ts` | 0 | Test Files 6 passed (6); Tests 178 passed (178) | 12 s | 5 / 177 | MET (+1 file, +1 test: the guard) |

**Known intermittent fired once on SQLite.** Unit run 1 failed one test: `packages/passkey/test/Contract.test.ts` > `runPluginContractTests` > `RecordsContract: passkey` > `RecordsContract: awthaq/passkey/records/ChallengeStore (sql)` > `consume [atomic]: false for any other value, a tampered one included` (`AssertionError: expected true to be false`, 10 ms; 1 failed, 6740 passed). That is the known intermittent 1; in the baseline capture it fired only on Postgres, here it fired on the SQLite-backed (default) run. Per the rule it was re-run once (`pnpm test`, exit 0, 429 files + 6 skipped, 6741 passed), so no second re-run was spent; the coverage run (which executes the same suite) was green with the same counts.

**knip, filtered** (`grep -v '^\.claude/' | grep -v '^\.reports/'` over the saved output), identical to the baseline block; the verify count of leftover rows is 0, `readme-quickstart.ts` rows 3, `git diff --stat knip.json | grep -c .` 0:

```text
$ knip
Unused files (39)
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

**Leak-guard comparison.** The sorted `[leak-guard]` lines of the bdd run: 40 lines, every one ending `apps=0 sqlClients=0`; `diff` against `07-LEAK-GUARD-BEFORE.txt` (39 lines) prints exactly one line, the guard file's:

```text
2d1
< [leak-guard] features/_guard/world-table.steps.test.ts apps=0 sqlClients=0
```

The five lines of the three Worlds' feature files are unchanged.

### Comparison rule verdicts

Rule 5 (the Postgres rule) is judged below with the Postgres legs.

1. MET. Every gate exits as in the baseline: all 0 except `pnpm knip`, exit 1 for the pre-existing findings only (the gate table above; the one unit failure was the known intermittent 1 and its single re-run exited 0).
2. MET. Counts only grow or stay equal: bdd 40 files / 1581 passed (+1 / +1, the guard), unit 429 + 6 skipped files and 6741 passed (equal), coverage 91.81 / 85.31 / 87.13 / 92.33 (equal, above the floors 89 / 83 / 84 / 90), `spec:verify:strict` PASS 32, FAIL 0, SKIP 0.
3. MET. `check:error-tags` prints 163 / 137, `check:contract-tests` prints 21 plugin classes; `check:readmes`, `circular` and `check:transactions` exit 0.
4. MET. knip's filtered output is the banner, the two headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line; `git diff --stat knip.json` is empty.
6. MET. `git diff --stat ee8b80a1 HEAD -- 'packages/*/package.json' features/package.json 'examples/*/package.json' pnpm-lock.yaml | grep -c .` prints 0.
7. MET. The sorted `[leak-guard]` lines equal `07-LEAK-GUARD-BEFORE.txt` plus the single guard-file line; every line ends `apps=0 sqlClients=0`.
8. MET (evidence in "Integrity" and "CRED-01 closure" above). The surface snapshots diff empty (identical sha) and `CredentialsSurface.test.ts` has one commit since the phase base.
