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

(Filled by Task 3 of plan 07-01.)

## Known intermittents

1. `packages/passkey/test/Contract.test.ts` > `runPluginContractTests` > `RecordsContract: passkey` > `RecordsContract: awthaq/passkey/records/ChallengeStore (memory or sql variant)` > `consume [atomic]: false for any other value, a tampered one included`. Did not fire in this capture.
2. `packages/organization/test/TenantMiddleware.test.ts` > `... a suspended organization still resolves (the plugin's own gate refuses it)`. Did not fire in this capture.
3. The admin `ImpersonationRecords (sql)` pair: `create [atomic]: an interrupted create leaves its row and its link together, or neither` and `create [race]: 8 creates racing verifyChain never report a break` (`Test timed out in 5000ms`; fire only in a full-suite Postgres run, never alone). Did not fire in this capture (SQLite legs).

Rule for later plans: a command whose only failures are these cases is re-run (at most twice) and every run is recorded; any other failure is a real regression. The Postgres container is recreated with `pg-fresh.sh` before each full Postgres run. Runs here: every SQLite gate ran once and passed (no re-run needed).

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

### Path allowlist

Every line of `git diff --name-only ee8b80a1 HEAD` must match:

```text
^(\.planning/|features/step-definitions/shared/EventCapture(\.types)?\.ts$|features/features/_guard/world-table\.steps\.test\.ts$|features/step-definitions/(AdminWorld|PasswordWorld|DomainWorld)\.ts$|packages/server/src/Credentials\.ts$|packages/server/src/internal/(PrincipalResolver|CredentialResolvers|Presented|Resolution|Scopes)\.ts$|packages/server/test/CredentialsSurface\.test\.ts$)
```

Plus the empty-diff checks: `git diff --name-only ee8b80a1 HEAD -- packages/test`, the importer packages (`packages/api-key`, `packages/jwt`, `packages/qadi`, `packages/web`, `packages/next`), every other `packages/*/src`, `packages/*/package.json`, `pnpm-lock.yaml`, `knip.json`, `.changeset`, `spec`, `docs`, `examples` print nothing; the 28 Worlds other than Admin, Password and Domain have an empty diff. No changeset, spec, docs, ADR or package.json change is planned (D-08: a pure internal split and a test-suite helper change no `@awthaq/server` output).
