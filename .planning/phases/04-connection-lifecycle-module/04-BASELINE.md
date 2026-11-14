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

Added by 04-02 under the `@BEH-EA-318` Rule of `features/features/13-enterprise-federation/29-saml-sp.feature` (REQ-EA ids from `features/scripts/allocate-req-ea.py`, `features/traceability.md` regenerated: 1361 ids, highest REQ-EA-1572), run against untouched `packages/*/src` (`git diff --quiet c683a1bc -- packages/organization/src packages/saml/src packages/scim/src packages/scim/package.json packages/scim/README.md spec .changeset examples` exits 0).

| REQ-EA | Scenario | State at 04-02 | First failing assertion (verbatim) |
|--------|----------|----------------|------------------------------------|
| REQ-EA-1569 | A suspended organization cannot gain a SAML connection, refused exactly like one that does not exist | RED | step `both are refused as {string} with the same answer`: `AssertionError: Expected values to be strictly equal: + actual - expected  + 'succeeded' - 'InvalidSamlConnectionRequest'` (`SamlFederationSteps.ts:1430`, `assert.equal(pair.realTag, tag)`: the suspended create succeeds through `directory.find`) |
| REQ-EA-1570 | A suspended organization's connection cannot be updated | RED | step `the update is refused as {string}`: `+ 'succeeded' - 'InvalidSamlConnectionRequest'` (the rename succeeds) |
| REQ-EA-1571 | A suspended organization's connection cannot be refreshed from its metadata | RED | step `the refresh is refused as {string}`: `+ 'refreshed' - 'InvalidSamlConnectionRequest'` (the refresh succeeds) |
| REQ-EA-1572 | A suspended organization's connection can still be deleted | GREEN (pins "no check on remove") | none |

Runs, against untouched `src`:

- `pnpm --filter @awthaq/features exec vitest run features/13-enterprise-federation/29-saml-sp.steps.test.ts`: exit 1, `Test Files  1 failed (1)`, `Tests  3 failed | 106 passed (109)`; the failures are exactly REQ-EA-1569, 1570 and 1571.
- `pnpm test:bdd`: exit 1, `Test Files  1 failed | 38 passed (39)`, `Tests  3 failed | 1577 passed | 44 skipped (1624)`. Against the 04-01 counts (1576 passed, 44 skipped, 1620 total): passed +1 (the green deletion scenario), skipped unchanged, total +4, and the only failures are the three rows above. Every other scenario passes.
- Rule for later plans: until 04-06 `pnpm test:bdd` is red by exactly these three rows and nothing else; any other BDD failure is a regression. The window closes in 04-06, where REQ-EA-1569, 1570 and 1571 turn green (then `pnpm test:bdd` reads 1580 passed, 44 skipped, 0 failed).
- 04-06 Task 1 (SAML create through the lifecycle): REQ-EA-1569 turned GREEN (CLOSED). `pnpm --filter @awthaq/features exec vitest run features/13-enterprise-federation/29-saml-sp.steps.test.ts`: exit 1, `Tests  2 failed | 107 passed (109)`; the two remaining reds are REQ-EA-1570 (update) and REQ-EA-1571 (refresh), closed by 04-06 Task 2. Closing commit: the Task 1 commit of 04-06 (`feat(04-06): route SAML create through OrganizationConnectionLifecycle`).
- 04-06 Task 2 (SAML update, refresh and remove through the lifecycle): the BDD red window is CLOSED. REQ-EA-1570 and REQ-EA-1571 turned GREEN. `pnpm test:bdd`: exit 0, `Test Files  39 passed (39)`, `Tests  1580 passed | 44 skipped (1624)`, 0 failed (the arithmetic above held: 1577 + 3). From here `pnpm test:bdd` is green and any failure is a regression. Closing commit: the Task 2 commit of 04-06 (`refactor(04-06): SAML update, refresh and remove through the lifecycle`).
- Steps added to `SamlFederationSteps.ts` (7) and one type-only widening of `AppServices` in `SamlWorld.ts` (adds `OrganizationRecords`, so the suspension step can use `OrganizationRecords.setSuspended` as `packages/saml/test/Saml.test.ts` does; `OrganizationDirectory` is not in `AppServices`).

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

## Wave 0 pins

Wave 0 pins are written and green against untouched `packages/*/src`: `git diff --quiet c683a1bc -- packages/organization/src packages/saml/src packages/scim spec features examples .changeset` exits 0 at each Wave 0 commit except for the one added SCIM test file (checked with the narrower `packages/scim/src packages/scim/package.json packages/scim/README.md` form in Task 3). No Wave 0 pin file imports `DomainClaims`; the OIDC pins build the store over `TestAuth.layer(Auth.make([Organization.Organization]), ...)` (the `RealLive` pattern), never over a hand-provided claim store, transaction or directory stub.

| Wave 0 file | Tests | Pins |
|---|---|---|
| `packages/organization/test/ConnectionLifecyclePins.test.ts` | 14 (7 cases x memory and SQL records) | unknown and suspended organization refused alike on create (`InvalidConnection`, "the organization does not exist"); suspended update refused the same way; suspended remove succeeds and frees the domain; a taken domain is `ConnectionDomainTaken` naming the first foreign domain in input order (z.example for [x, z, y]) with no `connectionCreated` event and x.example still claimable; a failed create holds no claim; a failed update keeps the previous domains and publishes no `connectionUpdated`; deleting an organization frees its domains and leaves no rows |
| `packages/organization/test/contract/DomainClaims.ts` (RecordsContract) | +1 case (16 lines added, 0 removed) | the refusal names the first domain, in the order the claim lists them, that another organization owns (c.example for [a, c, b]); runs on memory, SQLite and Postgres through `Contract.test.ts` |

Runs, against untouched `src`:

- `npx vitest run packages/organization/test/ConnectionLifecyclePins.test.ts packages/organization/test/Contract.test.ts` (SQLite): Test Files 2 passed (2); Tests 544 passed (544) (pins alone: 14 passed).
- The same two files with `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): Test Files 2 passed (2); Tests 545 passed (545).
- `npx tsc -b tsconfig.json` exit 0; `npx tsc -p tsconfig.test.json` prints no `error TS`; `pnpm lint` and `pnpm format:check` exit 0.
- Mutation seen to fail and reverted: expecting `domain: "y.example"` instead of `"z.example"` in the taken-domain pin failed 2 cases (memory and SQL); reverted, 14 pass again.

Task 3 additions (SAML store and admin pins, SCIM characterization), memory records only:

| Wave 0 file | Tests | Pins |
|---|---|---|
| `packages/saml/test/SamlLifecyclePins.test.ts` | 5 | taken domain is `SamlDomainTaken` at the store and `SamlDomainAlreadyRouted` through `saml.admin.createConnection`, both naming z.example for [x, z, y], no `auth.saml.connectionCreated` event; unknown organization is `InvalidSamlConnection` / `InvalidSamlConnectionRequest` with reason "the organization does not exist"; unknown connection id is `SamlConnections/NotFound` for `update`, `refreshMetadata`, `remove`; a suspended organization's connection can be removed and its domain is then free; a failed create holds no claim. The suspended-organization create/update/refresh refusals are deliberately absent (they flip in 04-02). |
| `packages/scim/test/ScimConnectionOrphan.test.ts` | 1 | FINDING F-04-01 characterization: `ScimConnectionStore.create` for `"no-such-organization"` succeeds, the connection is listed, `OrganizationDirectory.findActive` is `None` (flips under CONN-F1) |

- `npx vitest run packages/saml/test/SamlLifecyclePins.test.ts packages/scim/test/ScimConnectionOrphan.test.ts`: Test Files 2 passed (2); Tests 6 passed (6), against untouched `src`. `npx tsc -b tsconfig.json` exit 0; `npx tsc -p tsconfig.test.json` prints no `error TS`.
- Mutation seen to fail and reverted: expecting `domain: "y.example"` instead of `"z.example"` in the SAML store case failed that case (Tests 1 failed | 4 passed); reverted, 5 pass again.
- SCIM zero-diff proof at this commit: `git diff --stat c683a1bc -- packages/scim/src packages/scim/package.json packages/scim/README.md` prints nothing; the only change under `packages/scim` is the one added test file.
- The phase's finding is recorded in `04-FINDINGS.md` (F-04-01).

## Wave 0 red: Postgres race

`packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` (suite `organization_ConnectionLifecycleRace`, three cases, `describe.skipIf(AWTHAQ_POSTGRES_URL === undefined)`, `it.live`, 30 s per case, at most two concurrent fibers, `pg_sleep` triggers created per case and dropped in a finalizer). Added by 04-02 and never edited afterwards. Run against untouched `packages/*/src` (`git diff --quiet c683a1bc -- packages/organization/src packages/saml/src packages/scim/src packages/scim/package.json packages/scim/README.md spec .changeset examples` exits 0).

- Without the variable: `npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` exit 0, `Test Files  1 skipped (1)`, `Tests  3 skipped (3)`.
- With it: `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` exit 1, `Test Files  1 failed (1)`, `Tests  3 failed (3)` (1326 ms, 1840 ms, 735 ms). Run twice, identical result both times. run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).

| Case | Red because (verbatim diff, `- Expected` / `+ Received`) | Turns green in |
|------|-----------------------------------------------------------|----------------|
| `an update racing a remove of the same connection ends with nothing left and no deadlock` | `AssertionError: expected { remove: 'StoreUnavailable', …(6) } to deeply equal { remove: 'ok', …(6) }`: `claimRows` 0 vs 1, `connectionRows` 0 vs 1, `domainRows` 0 vs 1, `ownerRows` 0 vs 1, `remove` "ok" vs "StoreUnavailable", `storeUnavailable` 0 vs 1 (`update` is "ok or ConnectionRecordNotFound"). The deadlock victim is the remove in both runs (Postgres picks the waiter whose `deadlock_timeout` fires first; RESEARCH Experiment 1 saw the update), so the surviving update leaves its rows. | 04-05 (claims-first lifecycle under the 04-03 lock) |
| `two organizations claiming the same two domains in opposite order: one wins, the other is refused, no deadlock` | `AssertionError: expected { storeUnavailable: 1, …(2) } to deeply equal { storeUnavailable: +0, …(2) }`: `outcomes` `["ConnectionDomainTaken", "ok"]` expected, `["StoreUnavailable", "ok"]` received; `storeUnavailable` 0 vs 1 (the owner rows already name the one winner for x.example and y.example). | 04-03 (lock and sorted owner inserts) |
| `an organization deletion racing a create for it leaves no connection, claim or owner row behind` | `AssertionError: expected { delete: 'ok', …(4) } to deeply equal { delete: 'ok', …(4) }`: `claimRows` 0 vs 1, `connectionRows` 0 vs 1, `ownerRows` 0 vs 1 (the create lands an orphan connection, claim and owner row after the deletion cleared the organization; the create is not `StoreUnavailable`). | 04-05 (in-lock `findActive` re-check) |

Note for the later plans: a case name keeps the word `opposite` (case 2), the filter `-t 'opposite'` used by 04-03 selects only that case. The whole file is the phase-close Postgres oracle (see the comparison rule above).

## 04-03 Postgres

Plan 04-03 (DomainClaims advisory lock plus sorted owner acquisition). All Postgres results below: run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote). `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` passed explicitly.

### Task 1: lock, sorted acquisition, lock-key proof

- Memory and SQLite quick run (`DomainClaims.test.ts`, `Contract.test.ts`, `ConnectionLifecyclePins.test.ts`, `OrganizationConnections.test.ts`, `packages/saml/test/SamlLifecyclePins.test.ts`, `packages/saml/test/SamlDomainClaims.test.ts`): `Test Files  6 passed (6)`, `Tests  567 passed | 3 skipped (570)` (the 3 skipped are the Postgres-only "claim lock" cases).
- Postgres: `npx vitest run packages/organization/test/DomainClaims.test.ts packages/organization/test/Contract.test.ts packages/organization/test/ConnectionLifecyclePins.test.ts`: `Test Files  3 passed (3)`, `Tests  549 passed (549)`; the three "the claim lock" cases (claim, release, releaseAllForOrganization of org-1) pass: `organization_domain_claim:org:org-1` held, `organization_domain_claim:org:org-2` not.
- Race file on Postgres (`OrganizationConnectionLifecycle.sql.test.ts`): `Tests  2 failed | 1 passed (3)`; `-t 'opposite'`: `Tests  1 passed | 2 skipped (3)`.

| Race case | State after 04-03 | Current assertion message |
|-----------|-------------------|---------------------------|
| `an update racing a remove of the same connection ...` (1) | red, unchanged from Wave 0 | `expected { remove: 'StoreUnavailable', …(6) } to deeply equal { remove: 'ok', …(6) }`: `claimRows` 0 vs 1, `connectionRows` 0 vs 1, `domainRows` 0 vs 1, `ownerRows` 0 vs 1, `remove` "ok" vs "StoreUnavailable", `storeUnavailable` 0 vs 1; needs the claims-first lifecycle (04-05) |
| `two organizations claiming the same two domains in opposite order ...` (2) | GREEN | (turned green by the sorted owner inserts plus the organization-level lock) |
| `an organization deletion racing a create for it ...` (3) | red, unchanged from Wave 0 | `expected { delete: 'ok', …(4) } to deeply equal { delete: 'ok', …(4) }`: `claimRows` 0 vs 1, `connectionRows` 0 vs 1, `ownerRows` 0 vs 1; needs the in-lock `findActive` re-check (04-05) |

### Task 2: additive concurrent contract cases

Three `race` cases added to `packages/organization/test/contract/DomainClaims.ts` (additions only; `git diff c683a1bc -- packages/organization/test/contract/DomainClaims.ts | grep -c '^-[^-]'` prints 0): one organization's two connections claiming the same domains in opposite order (all succeed, the organization owns both); two organizations claiming x/y in opposite order (only success or DomainClaimTaken, one winner, both domains with that owner); release and claim of one connection interleaved (no orphan, a.example free, final release leaves b.example free).

- Memory and SQLite: `npx vitest run packages/organization/test/Contract.test.ts`: `Tests  536 passed (536)`; `pnpm check:contract-tests`: all 21 plugin classes.
- Postgres (`AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq`, run three times): `Tests  537 passed (537)` every run, no StoreUnavailable.
- Race case 2 after Task 2: `-t 'opposite'` still `Tests  1 passed | 2 skipped (3)`.

### 04-03 gates

`tsc -b` clean; `pnpm check:transactions`, `pnpm check:error-tags` (163 internal / 137 wire), `pnpm circular`, `pnpm lint` (exit 0, no warnings under `packages/`), `pnpm format:check` exit 0. `pnpm test:bdd`: `Tests  3 failed | 1577 passed | 44 skipped (1624)`, red by exactly the three 04-02 SAML suspended-organization rows (the BDD red window), no other failure.

## 04-05 Postgres

Plan 04-05 (OIDC store over the lifecycle). All Postgres results below: run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote). `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` passed explicitly.

- After Task 1 (OIDC create through the lifecycle): `npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` exit 1, `Tests  1 failed | 2 passed (3)`; the failing case is `an update racing a remove of the same connection ...` (deletion racing create now passes).
- After Task 2 (update and remove through the lifecycle, claims first): the same command, exit 0, `Tests  3 passed (3)`, no StoreUnavailable.
- `npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts packages/organization/test/Contract.test.ts packages/organization/test/ConnectionLifecyclePins.test.ts packages/organization/test/OrganizationConnectionLifecycle.test.ts`: exit 0, `Test Files  4 passed (4)`, `Tests  582 passed (582)`.

| Race case | State after 04-05 |
|-----------|-------------------|
| update racing remove (1) | GREEN (claims-first removal through the per-organization lock) |
| opposite-order claims (2) | GREEN |
| deletion racing create (3) | GREEN (in-lock `findActive` re-check; order -1 claim release) |

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

### 04-05 gates

`tsc -b` and `tsc -p tsconfig.test.json` clean (only the pre-existing TS377149 warnings); `pnpm check:transactions`, `pnpm circular`, `pnpm lint`, `pnpm format:check` exit 0; `pnpm check:error-tags`: 163 internal / 137 wire. `pnpm test`: 421 files, 6649 tests passed (1 expected fail, 21 skipped). `pnpm knip`: exit 1 for the baseline reasons only (3 `readme-quickstart.ts` unlisted dependencies plus untracked `.claude/` files), no row under `packages/organization`. `pnpm test:bdd`: `Tests  3 failed | 1577 passed | 44 skipped (1624)`, red by exactly the three 04-02 SAML rows (REQ-EA-1569, 1570, 1571) until 04-06; no other failure.

## 04-06 Postgres and gates

Plan 04-06 (SAML store over the lifecycle). Postgres results: run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote). `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` passed explicitly.

- `npx vitest run packages/saml/test/SamlLifecyclePins.test.ts packages/saml/test/SamlDomainClaims.test.ts packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts`: exit 0, `Test Files  3 passed (3)`, `Tests  13 passed (13)`.

### 04-06 gates

`tsc -b` and `tsc -p tsconfig.test.json` clean (only the pre-existing TS377149 warnings); `pnpm check:transactions`, `pnpm circular`, `pnpm lint` (warnings only under untracked `.claude/`), `pnpm format:check` exit 0; `pnpm check:error-tags`: 163 internal / 137 wire. `pnpm test`: 421 files, 6649 tests passed (1 expected fail, 21 skipped). `pnpm knip`: exit 1 for the baseline reasons only (3 `readme-quickstart.ts` unlisted dependencies plus untracked `.claude/` files), no row under `packages/`. `pnpm test:bdd`: `Tests  1580 passed | 44 skipped (1624)`, 0 failed: the BDD red window is closed.

## Phase close

Recorded by 04-09 at HEAD `fa29e41f493441859e7090bab7cb71be33a87a83` (branch `architecture/deepening-batch-3`; phase base `c683a1bc`). No `src` file changed in 04-09. All commands run from the worktree root; SQLite and memory runs with `AWTHAQ_POSTGRES_URL` unset, Postgres runs with `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` passed explicitly on the same container as the baseline (`awthaq-p3-pg`, Debian `postgres:16`).

### Path allowlist (CONN-06)

`git diff --name-only c683a1bc HEAD` lists 57 paths (22 under `.planning/`); piping the list through `grep -vE` with the 04-09 allowlist regex prints nothing (grep exit 1, no offender). The non-planning paths: `.changeset/connection-lifecycle-module.md`, `examples/{memory,sql}-server/app.ts`, `features/features/13-enterprise-federation/29-saml-sp.feature`, `features/step-definitions/{OrganizationWorld,QadiOrganizationFixture,SamlFederationSteps,SamlWorld,TenancyWorld}.ts`, `features/traceability.md`, `packages/organization/README.md`, 6 organization `src` and 8 organization `test` files (one under `test/contract/`), `packages/saml/src/{Saml,SamlConnections}.ts`, `packages/saml/test/{SamlDomainClaims,SamlLifecyclePins}.test.ts`, `packages/scim/test/ScimConnectionOrphan.test.ts`, `spec/behaviors/{28-tenancy,29-saml-sp}.md`, `spec/decisions/040-plugin-exposes-domain-services.md`, `spec/models/09-sso.md`, `spec/traceability.md`.

### SCIM proofs

- `git diff --stat c683a1bc HEAD -- packages/scim/src packages/scim/package.json packages/scim/README.md` prints nothing.
- `git diff --name-status c683a1bc HEAD -- packages/scim` prints exactly `A	packages/scim/test/ScimConnectionOrphan.test.ts`.
- `04-FINDINGS.md` records `FINDING F-04-01: SCIM createConnection accepts an unknown organization` (CONN-06, disposition recorded only) and the deferral CONN-F1; the characterization test passes against untouched SCIM `src`.

### Structural census

| Census command | c683a1bc | Now | Expect |
|----------------|----------|-----|--------|
| `grep -rnE '\bwith(Claim\|Release)\b' packages/*/src \| wc -l` | 9 | 0 | 0 |
| `grep -rl 'DomainClaims' packages/*/src \| grep -v '^packages/organization/' \| wc -l` | 2 | 0 | 0 |
| `grep -rn 'const DOMAIN = ' packages/*/src` | 2 lines (`OrganizationConnections.ts:338`, `SamlConnections.ts:91`) | 1 line, `packages/organization/src/OrganizationConnectionLifecycle.ts:64` | 1, in `OrganizationConnectionLifecycle.ts` |
| `grep -c 'directory\.find(' packages/saml/src/SamlConnections.ts` | 1 | 0 | 0 |
| `grep -c 'SqlStore.atomically' packages/organization/src/DomainClaims.ts` | 0 | 4 | at least 3 |
| `grep -rniE '@awthaq/saml\|SamlRecords\|SamlDomainTaken\|InvalidSamlConnection' packages/organization/src \| wc -l` | 2 | 2 (`OrganizationActor.ts:24` and `OrganizationMigrations.ts:464`, the same two comment lines) | 2 |
| `grep -c 'export \* as DomainClaims' packages/organization/src/index.ts` | 1 | 0 | 0 |
| `grep -c '@awthaq/saml' packages/organization/package.json` | 0 | 0 | 0 |

### Wave 0 oracle integrity

`git log --format=%h c683a1bc..HEAD -- <file>` prints exactly one commit for each: `packages/organization/test/ConnectionLifecyclePins.test.ts` (`ccc79daf`), `packages/saml/test/SamlLifecyclePins.test.ts` (`5b070b92`), `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` (`9802322d`), `packages/scim/test/ScimConnectionOrphan.test.ts` (`5b070b92`): none edited after its add commit. `git diff --numstat c683a1bc HEAD -- packages/organization/test/contract/DomainClaims.ts` prints `112	0	packages/organization/test/contract/DomainClaims.ts` (112 lines added, 0 removed). `git diff --stat knip.json` is empty.

### Gate table against the baseline

| Gate | Command | Exit | Summary line printed | Wall time | Baseline | Verdict |
|------|---------|------|----------------------|-----------|----------|---------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output), 0 `error TS` | 1 s | 0 | as baseline |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; the same 2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts` | 3 s | 0 | as baseline |
| circular | `pnpm circular` | 0 | no findings | 3 s | 0 | as baseline |
| error tags | `pnpm check:error-tags` | 0 | `163 internal and 137 wire error tags, none shared` | 1 s | 163 / 137 | same numbers |
| transactions | `pnpm check:transactions` | 0 | `no bare sql.withTransaction in packages/*/src` | 0 s | 0 | as baseline |
| contract tests | `pnpm check:contract-tests` | 0 | `all 21 plugin classes run the contract suite` | 1 s | 21 | same number |
| lint | `pnpm lint` | 0 | warnings only (`.claude/` untracked tree, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors, none under `packages/` | 0 s | 0 | as baseline |
| format | `pnpm format:check` | 0 | `All matched files use the correct format ... on 1224 files` | 1 s | 0 (1218 files) | as baseline (6 more files) |
| readmes | `pnpm check:readmes` | 0 | `every package README matches its package's shipped state` | 0 s | 0 | as baseline |
| workspace | `pnpm workspace:check` | 0 | `29 packages and 3 examples match every roster` | 1 s | 0 | as baseline |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | 8 s | 1576 / 44 skipped | grew by the 4 BEH-EA-318 scenarios, 0 failed |
| unit | `pnpm test` | 0 | Test Files 420 passed, 6 skipped (426); Tests 6648 passed, 1 expected fail, 21 skipped (6670) | 44 s | 417 + 4 skipped (421); 6593 + 1 expected fail + 15 skipped | grew: +5 files (+3 passed, +2 skipped), +55 passed tests; the +6 skipped tests are the Postgres-only race (3) and claim-lock (3) cases, which ran on Postgres below (the run there has 0 skipped) |
| coverage | `pnpm coverage` | 0 | Statements 91.73, Branches 85.22, Functions 87.03, Lines 92.25 (floors 89 / 83 / 84 / 90); same 420 / 6 skipped files and 6648 / 1 expected fail / 21 skipped tests | 51 s | 91.71 / 85.20 / 86.95 / 92.24 | above floors, every figure at or above baseline |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 50 s | 32 / 0 / 0 | as baseline |
| knip | `pnpm knip` | 1 (pre-existing) | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 65 s | 1 | filtered output identical (below) |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages (30 PASS, 0 other) | 40 s | 30 PASS | as baseline |

knip, `pnpm knip 2>&1 | grep -v '^\.claude/' | grep -v '^\.reports/'`, filtered output (extraction of the baseline block done by hand; identical to it, no row under `packages/` other than the three `readme-quickstart.ts` rows):

```text
$ knip
Unused files (39)
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

No re-run was needed on the SQLite and memory side: `pnpm test` and `pnpm coverage` were green on their first run (neither known intermittent fired).

### Postgres

Container `awthaq-p3-pg`, the Debian `postgres:16` CI image of the baseline; `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` passed explicitly on each command.

| Run | Command | Exit | Summary line printed | Failing tests | Wall time |
|-----|---------|------|----------------------|---------------|-----------|
| baseline targeted legs | `npx vitest run packages/organization/test/Contract.test.ts packages/organization/test/OrganizationSql.test.ts packages/organization/test/OrganizationConnections.test.ts packages/saml/test/Contract.test.ts packages/saml/test/SamlDomainClaims.test.ts packages/scim/test/Contract.test.ts` | 0 | Test Files 6 passed (6); Tests 774 passed (774) (baseline 766) | none | 40 s |
| phase files and race oracle | `npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts packages/organization/test/OrganizationConnectionLifecycle.test.ts packages/organization/test/DomainClaims.test.ts packages/organization/test/Contract.test.ts packages/organization/test/ConnectionLifecyclePins.test.ts packages/saml/test/SamlLifecyclePins.test.ts` | 0 | Test Files 6 passed (6); Tests 590 passed (590), including the 3 race cases of `OrganizationConnectionLifecycle.sql.test.ts` and the 3 claim-lock cases of `DomainClaims.test.ts` | none | 38 s |
| full unit, run 1 | `pnpm test` | 1 | Test Files 1 failed, 425 passed (426); Tests 1 failed, 6689 passed, 1 expected fail (6691) | `packages/passkey/test/Contract.test.ts > ... ChallengeStore (sql) > consume [atomic]: false for any other value, a tampered one included` (the Phase 2 known intermittent, no connection or SAML test) | 87 s |
| full unit, run 2 (the one re-run) | `pnpm test` | 0 | Test Files 426 passed (426); Tests 6690 passed, 1 expected fail (6691) (0 skipped) | none | 92 s |
| full bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1580 passed, 44 skipped (1624) | none | 13 s |

The full-suite failing list is empty after the one recorded re-run (baseline: empty); it did not grow. Baseline Postgres full unit: 421 files, 6629 passed; now 426 files, 6690 passed.

run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)

### Comparison rule verdicts

1. Every gate exits as in the baseline (all 0 except `pnpm knip`, 1 for the pre-existing reasons): MET.
2. Counts only grow; coverage 91.73 / 85.22 / 87.03 / 92.25 at or above 91.71 / 85.20 / 86.95 / 92.24 and the floors 89 / 83 / 84 / 90; spec PASS 32, FAIL 0, SKIP 0: MET.
3. `check:error-tags` 163 / 137 and `check:contract-tests` 21: MET.
4. knip filtered output gains nothing, `git diff --stat knip.json` empty: MET.
5. Postgres: every targeted leg and `OrganizationConnectionLifecycle.sql.test.ts` pass, the full-suite failing list did not grow (empty after one re-run of the known passkey intermittent): MET, CI confirmation open.
6. The no-SAML grep prints the two comment lines, `@awthaq/saml` count in `packages/organization/package.json` is 0: MET.
7. `withClaim`/`withRelease` 0 lines, no `DomainClaims` outside organization src, one `const DOMAIN = ` in `OrganizationConnectionLifecycle.ts`, `directory.find(` 0, `atomically` 4: MET.
8. SCIM proofs: MET.
9. Wave 0 oracles one commit each, contract file additions only: MET.
10. Phase allowlist, no offender: MET.
