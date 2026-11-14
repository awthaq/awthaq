# Phase 4 Gate Baseline

**HEAD at capture:** `4b43eb7dacf433bd584ce2da1106e9c305cce413` (branch `architecture/deepening-batch-3`; phase base commit `c683a1bc`, only `.planning/` changed since)
**Captured:** 2026-11-14, on a tree where `git diff --quiet c683a1bc -- packages spec features examples .changeset knip.json scripts` exits 0 (precondition met before the first gate and re-checked after the Postgres runs; the same command also exits 0 at the end of the capture). `docker exec awthaq-p3-pg pg_isready -U postgres` exits 0 (`/var/run/postgresql:5432 - accepting connections`).
**Toolchain:** node v26.13.0, pnpm 11.20.0, `npx tsc -v` = `Version 7.0.2+effect-tsgo.0.67.4`
**Postgres server:** `PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`
**Method:** each gate run on its own from the worktree root in the order below with `AWTHAQ_POSTGRES_URL` unset, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/` (its 0 s is an up-to-date incremental build). Output of every gate saved outside the repo.

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output), 0 `error TS` | 0 s (<1 s) |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 4 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 4 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 0 s (<1 s) |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 1 s |
| contract tests | `pnpm check:contract-tests` | 0 | `contract-tests: all 21 plugin classes run the contract suite; @awthaq/test stays dev-only` | 0 s (<1 s) |
| lint | `pnpm lint` | 0 | oxlint: warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors | 1 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1218 files` | 1 s |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 0 s (<1 s) |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 0 s (<1 s) |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1576 passed, 44 skipped (1620) | 10 s |
| unit | `pnpm test` | 0 on the third run (see "Known intermittents") | Test Files 417 passed, 4 skipped (421); Tests 6593 passed, 1 expected fail, 15 skipped (6609) | 44 s |
| coverage | `pnpm coverage` | 0 | Statements 91.71, Branches 85.20, Functions 86.95, Lines 92.24 (floors 89 / 83 / 84 / 90); same 417 / 4 skipped files, 6593 / 1 expected fail / 15 skipped tests | 51 s |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 51 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 67 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 40 s |

Versus the Phase 3 baseline: 6 more test files and 102 more tests (417 / 6593 against 411 / 6491), the Phase 3 Wave 0 and plan tests; coverage 91.71 / 85.20 / 86.95 / 92.24 against 91.66 / 85.08 / 86.93 / 92.18.

## Phase pins

| Pin | Command | Exit | Summary line printed | Wall time |
|-----|---------|------|----------------------|-----------|
| organization connection pins | `npx vitest run packages/organization/test/DomainClaims.test.ts packages/organization/test/OrganizationConnections.test.ts packages/organization/test/Contract.test.ts packages/organization/test/OrganizationDeletion.test.ts` | 0 | Test Files 4 passed (4); Tests 545 passed (545) | 3 s |
| saml and scim pins | `npx vitest run packages/saml/test/SamlDomainClaims.test.ts packages/saml/test/SamlConnections.test.ts packages/saml/test/SamlAdmin.test.ts packages/saml/test/SamlOrganizationDeletion.test.ts packages/saml/test/Sso.test.ts packages/scim/test/ScimOrganizationDeletion.test.ts` | 0 | Test Files 6 passed (6); Tests 44 passed (44) | 2 s |

## knip (raw)

Full `pnpm knip` output (trailing whitespace trimmed), exit code 1: 39 `Unused files` rows, all under the untracked `.claude/` tree (the same list as the Phase 1 to 3 captures), then:

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

No unused exports, no unused dependencies, nothing under `packages/` other than the three `readme-quickstart.ts` unlisted-dependency rows. (Identical to the Phase 1 to 3 baselines.)

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
```

`git diff --stat knip.json` (verbatim): empty (`knip.json` is unmodified at capture). Recorded as found; nothing was reverted or edited.

## Postgres

Container `awthaq-p3-pg`, image Debian `postgres:16` (server string above), `postgres://postgres:pw@localhost:55433/awthaq` (a throwaway local credential); this is the image CI uses (`.github/workflows/check.yml` runs `postgres:16`), not `scripts/test-pg.sh`'s alpine image. `AWTHAQ_POSTGRES_URL` was passed explicitly on each command below.

| Run | Command | Exit | Summary line printed | Failing tests | Wall time |
|-----|---------|------|----------------------|---------------|-----------|
| targeted legs | `npx vitest run packages/organization/test/Contract.test.ts packages/organization/test/OrganizationSql.test.ts packages/organization/test/OrganizationConnections.test.ts packages/saml/test/Contract.test.ts packages/saml/test/SamlDomainClaims.test.ts packages/scim/test/Contract.test.ts` | 0 | Test Files 6 passed (6); Tests 766 passed (766) | none | 38 s |
| full unit | `pnpm test` | 0 | Test Files 421 passed (421); Tests 6629 passed, 1 expected fail (6630) (0 skipped: the 4 skipped files and 15 skipped tests of the SQLite run execute) | none | 88 s |
| full bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1576 passed, 44 skipped (1620) | none | 13 s |

Verbatim failing-test list for the Postgres full-suite record: empty. There are no pre-existing Postgres failures at this HEAD (the Phase 3 collation items did not reproduce on this tree).

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

## Structural baselines

Measured at HEAD above (every command from the worktree root, output verbatim).

1. No SAML in the organization package. `grep -rniE "@awthaq/saml|SamlRecords|SamlDomainTaken|InvalidSamlConnection" packages/organization/src` prints the two comment lines:

   ```text
   packages/organization/src/OrganizationActor.ts:24:  /** An identity provider (`@awthaq/saml`) mapping roles at sign-in. */
   packages/organization/src/OrganizationMigrations.ts:464:  // other); `@awthaq/saml`'s own migration backfills its domains after this one and refuses a cross-organization clash.
   ```

   `grep -c '@awthaq/saml' packages/organization/package.json` prints `0`.
2. The DomainClaims root and sub-path export lines. `grep -n 'DomainClaims' packages/organization/src/index.ts packages/organization/src/records.ts`:

   ```text
   packages/organization/src/records.ts:23:export * as DomainClaims from "./DomainClaims.ts";
   packages/organization/src/index.ts:11:export * as DomainClaims from "./DomainClaims.ts";
   ```
3. The 9 src lines naming withClaim/withRelease. `grep -rnE '\bwith(Claim|Release)\b' packages/*/src`:

   ```text
   packages/organization/src/DomainClaims.ts:210:export const withClaim = <A, E, R, Taken>(
   packages/organization/src/DomainClaims.ts:226:    Effect.catchTag("SqlError", StoreFailure.storeUnavailable("DomainClaims.withClaim")),
   packages/organization/src/DomainClaims.ts:229:/** Deletes a connection and releases its claim as one unit (the same transaction rule as `withClaim`). */
   packages/organization/src/DomainClaims.ts:230:export const withRelease = <A, E, R>(
   packages/organization/src/DomainClaims.ts:239:    .pipe(Effect.catchTag("SqlError", StoreFailure.storeUnavailable("DomainClaims.withRelease")));
   packages/organization/src/OrganizationConnections.ts:436:      DomainClaims.withClaim(
   packages/organization/src/OrganizationConnections.ts:578:        yield* DomainClaims.withRelease(
   packages/saml/src/SamlConnections.ts:225:      DomainClaims.withClaim(
   packages/saml/src/SamlConnections.ts:512:            DomainClaims.withRelease(
   ```
4. DomainClaims references outside organization src. `grep -rn 'DomainClaims' packages/*/src | grep -v '^packages/organization/src/'`:

   ```text
   packages/saml/src/SamlConnections.ts:26:import { DomainClaims, OrganizationAuthority, OrganizationDirectory } from "@awthaq/organization";
   packages/saml/src/SamlConnections.ts:206:/** Requires `SamlRecords`, `DomainClaims` (organization's record store), `SqlTransaction`, the exposed `OrganizationDirectory`, the exposed `OrganizationAuthority`, `SamlSpKeys`, `SecureRandom` and `SamlConfig`. */
   packages/saml/src/SamlConnections.ts:211:    const claims = yield* DomainClaims.DomainClaims;
   packages/saml/src/SamlConnections.ts:221:      input: DomainClaims.DomainClaim,
   packages/saml/src/SamlConnections.ts:225:      DomainClaims.withClaim(
   packages/saml/src/SamlConnections.ts:512:            DomainClaims.withRelease(
   packages/saml/src/Saml.ts:57:  DomainClaims,
   packages/saml/src/Saml.ts:727:    const claims = yield* DomainClaims.DomainClaims;
   ```
5. The two DOMAIN/normalizeDomains copies. `grep -rnE '^const DOMAIN = |const normalizeDomains' packages/*/src` (4 lines, two files):

   ```text
   packages/organization/src/OrganizationConnections.ts:338:const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
   packages/organization/src/OrganizationConnections.ts:340:const normalizeDomains = (
   packages/saml/src/SamlConnections.ts:91:const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
   packages/saml/src/SamlConnections.ts:93:const normalizeDomains = (domains: ReadonlyArray<string>) => {
   ```
6. SAML's raw directory lookup. `grep -n 'directory\.find(\|findActive' packages/saml/src/SamlConnections.ts` (one `directory.find(` line, no `findActive`):

   ```text
   331:      const found = yield* directory.find(input.organizationId);
   ```
7. SqlTransaction references in the SAML store and plugin. `grep -n 'SqlTransaction' packages/saml/src/SamlConnections.ts packages/saml/src/Saml.ts`:

   ```text
   packages/saml/src/SamlConnections.ts:27:import { OutboundUrl, SqlTransaction, Tenant } from "@awthaq/ports";
   packages/saml/src/SamlConnections.ts:206:/** Requires `SamlRecords`, `DomainClaims` (organization's record store), `SqlTransaction`, the exposed `OrganizationDirectory`, the exposed `OrganizationAuthority`, `SamlSpKeys`, `SecureRandom` and `SamlConfig`. */
   packages/saml/src/SamlConnections.ts:212:    const transaction = yield* SqlTransaction.SqlTransaction;
   packages/saml/src/Saml.ts:53:  SqlTransaction,
   packages/saml/src/Saml.ts:790:    ports: [RateLimiter.RateLimiter, SqlTransaction.SqlTransaction, XmlSignature.XmlSignature],
   ```
8. DomainClaims transaction idiom. `grep -c 'atomically' packages/organization/src/DomainClaims.ts` prints `0`; `grep -c 'transactional(sql)' packages/organization/src/DomainClaims.ts` prints `3`.

## SCIM path list

`git ls-files packages/scim | wc -l` prints `27`. Location decision: `@awthaq/scim` is importable only from `packages/scim` and `features/`, so the SCIM orphan characterization test lives in `packages/scim/test/ScimConnectionOrphan.test.ts`, the only change under `packages/scim` in the whole phase (it pins a FINDING and changes no SCIM behaviour). Phase-close proofs, run from the worktree root:

- `git diff --stat c683a1bc HEAD -- packages/scim/src packages/scim/package.json packages/scim/README.md` must print nothing (at capture: nothing).
- `git diff --name-status c683a1bc HEAD -- packages/scim` must print exactly one line, `A	packages/scim/test/ScimConnectionOrphan.test.ts` (at capture: nothing, the file is added by 04-01 Task 3).

## Known intermittents

1. `packages/passkey/test/Contract.test.ts > runPluginContractTests > RecordsContract: passkey > RecordsContract: awthaq/passkey/records/ChallengeStore (sql) > consume [atomic]: false for any other value, a tampered one included` (the Phase 2 known intermittent) failed in the first `pnpm test` run of this capture (`Test Files 1 failed | 416 passed | 4 skipped (421)`, `Tests 1 failed | 6592 passed | 1 expected fail | 15 skipped (6609)`, exit 1, 44 s) and was the run's only failure.
2. The re-run (the one re-run the rule allows) failed in a different place: `packages/organization/test/TenantMiddleware.test.ts > Organization.tenantMiddleware (BEH-EA-234) > a suspended organization still resolves (the plugin's own gate refuses it)` (a loopback HTTP call to `/whoami` answered a 404 `not found` body; same totals `1 failed | 416 passed`, exit 1, 45 s). It is not a SAML, SCIM or connection test and passed in isolation 3 of 3 runs (`npx vitest run packages/organization/test/TenantMiddleware.test.ts`: 6 passed, 1 skipped). Recorded as a second intermittent (a loopback port race under whole-suite load), outside this phase's scope and not touched.
3. A third `pnpm test` run was green: exit 0, 417 passed, 4 skipped (421) files; 6593 passed, 1 expected fail, 15 skipped (6609) tests, 44 s. `pnpm coverage` (the same suite) was green first time. The gate table's unit row is that green run. Rule for later plans: a command whose only failures are one of the two cases above is re-run (twice at most) and every run is recorded; any other failure is a real regression.

## BDD red window

(to be filled by 04-02: the failing-first BDD rows for the SAML suspended-organization refusals, with their red output and the commit where they turn green)

## Phase-close comparison rule

Every gate exits as it did here: all gates 0 except `pnpm knip`, which exits 1 for the pre-existing reasons above.

- Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `FAIL 0` (the PASS count is 32 here and may only grow).
- `pnpm check:error-tags` and `pnpm check:contract-tests` print the same numbers as above (163 / 137, 21 plugin classes).
- knip's filtered output gains nothing: only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, with no row under `packages/`; `git diff --stat knip.json` stays empty.
- The Postgres full-suite failing list (empty here) does not grow, and every targeted leg above plus `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` passes on Postgres (record again as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)").
- The no-SAML grep (Structural baselines 1) still prints only the two comment lines, and `grep -c '@awthaq/saml' packages/organization/package.json` stays `0`.
- The src `withClaim`/`withRelease` grep (item 3) prints 0 lines; no `DomainClaims` reference outside organization src (item 4 prints nothing); one `const DOMAIN = ` in `packages/*/src`, in `OrganizationConnectionLifecycle.ts`; `directory.find(` count 0 in `SamlConnections.ts`; `atomically` count at least 3 in `DomainClaims.ts`.
- The SCIM proofs as in "SCIM path list".
- The Wave 0 pin files (`packages/organization/test/ConnectionLifecyclePins.test.ts`, `packages/saml/test/SamlLifecyclePins.test.ts`, `packages/scim/test/ScimConnectionOrphan.test.ts`) are byte-unchanged after their add commits; `packages/organization/test/contract/DomainClaims.ts` only gained lines (`git diff c683a1bc -- packages/organization/test/contract/DomainClaims.ts | grep -c '^-[^-]'` prints 0).
- The phase allowlist is the one 04-09 checks, measured from `c683a1bc` with `git diff --name-only c683a1bc HEAD`.
