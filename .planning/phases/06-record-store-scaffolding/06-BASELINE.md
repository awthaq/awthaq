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

(Recorded by 06-01 Task 2: RC9, full `pnpm test` and full `pnpm test:bdd` against the Debian `postgres:16` container.)

## Known intermittents

1. `packages/passkey/test/Contract.test.ts` > `runPluginContractTests` > `RecordsContract: passkey` > `RecordsContract: awthaq/passkey/records/ChallengeStore (memory or sql variant)` > `consume [atomic]: false for any other value, a tampered one included`. **Fired in this capture** on the first `pnpm coverage` run (the memory variant): `Test Files 1 failed | 422 passed | 6 skipped (429)`, `Tests 1 failed | 6698 passed | 1 expected fail | 23 skipped (6723)`, exit 1, 84 s; it was that run's only failure. The one re-run was green (exit 0, 106 s, the coverage numbers in the gate table). The first `pnpm test` run (run before coverage) was green first time.
2. `packages/organization/test/TenantMiddleware.test.ts` > `... a suspended organization still resolves (the plugin's own gate refuses it)`. Did not fire in this capture.

Rule for later plans: a command whose only failures are one of these two cases is re-run (at most twice) and every run is recorded; any other failure is a real regression. Runs here: coverage run 1 (exit 1, intermittent 1), coverage run 2 (exit 0); every other gate ran once.

## Phase-close comparison rule

Every gate exits as it did here, and the comparison is made on a tree where `git diff --stat knip.json` is empty.

1. Every gate exits as here: all 0 except `pnpm knip`, which exits 1 only for the pre-existing findings above.
2. Test, file and coverage counts may only grow; coverage stays at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` stays `FAIL 0` and `SKIP 0`, with PASS at or above 32 (this capture).
3. `pnpm check:error-tags` and `pnpm check:contract-tests` print the same numbers as here (163 / 137, 21 plugin classes), and `pnpm check:readmes`, `pnpm circular` and `pnpm check:transactions` exit 0.
4. knip's filtered output gains nothing: only the banner, the headings, the three `readme-quickstart.ts` rows and the ELIFECYCLE line, no row under `packages/` besides them; `git diff --stat knip.json` stays empty.
5. RC9 passes on SQLite and on Postgres (full command and the nine suite paths in "Phase pins" above), and the Postgres full-suite failing list does not grow (record again as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)").
6. No new dependency: `git diff --stat 3be32564 HEAD -- packages/*/package.json features/package.json examples/*/package.json pnpm-lock.yaml` prints nothing.

### Path allowlist

Every line of `git diff --name-only 3be32564 HEAD` must match the no-go set:

```text
^(spec/decisions/041-domain-store-ports\.md$|\.planning/)
```

and on a no-go, `git diff --quiet 3be32564 HEAD -- packages features examples docs .changeset scripts knip.json pnpm-lock.yaml` exits 0 (no package, docs, template or changeset change: no scaffolding code lands).

This set covers both spike outcomes for the work planned now: plans 06-01 to 06-03 touch only `.planning/` and, at most, `spec/decisions/041-domain-store-ports.md`. A go-branch plan, written only after `06-SPIKE.md` says go, may widen the set solely by appending the exact paths it names: the adopting `packages/*/src/*Records.ts`, the helper module and its test, its Wave 0 pin file, one `.changeset/<name>.md`, `docs/plugin-authoring.md`, `examples/plugin-template/` files, and `spec/overview.md` / `spec/traceability.md` only if the public surface changes. A path not named by such a plan stays outside the allowlist.

### Go-branch obligations

Quoting 06-CONTEXT: before any `src` change the go branch pins today's behaviour for every file it touches (operation labels, lock keys, verdicts, ordering/comparator results, tenant visibility) and freezes each module's current `Ref` count rather than asserting one (`ImpersonationRecords` keeps two `Ref`s and a `Semaphore`), and `docs/plugin-authoring.md` and `examples/plugin-template/` update last. The Wave 0 pin files are written and green against untouched `packages/*/src` (`git diff --quiet 3be32564 -- packages/*/src` exits 0 at each Wave 0 commit), every expected value an inline literal.
