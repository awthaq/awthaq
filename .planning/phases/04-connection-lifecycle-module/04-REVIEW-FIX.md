---
phase: 04-connection-lifecycle-module
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/04-connection-lifecycle-module/04-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 7
skipped: 0
deferred: 1
status: all_fixed
---

# Phase 4: Code Review Fix Report

**Fixed at:** 2026-11-14
**Source review:** .planning/phases/04-connection-lifecycle-module/04-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 8 (2 Warning, 6 Info; no Critical; fix scope widened to Info by the caller)
- Fixed: 7 (one commit each, code and test together)
- Skipped: 0
- Deferred: 1 (IN-04, recorded as F-04-02 in `04-FINDINGS.md`)

Edited in the worktree checkout (`architecture/deepening-batch-3`); verification ran there. Locked decisions held: suspended gate `findActive` on create and update only, suspended equals missing, claims first under the per-organization lock, sorted owner inserts, in-lock re-check on create, no events in the lifecycle, `organization` imports no SAML type, no new error tag (163/137), SCIM sources untouched, `check:transactions` passes.

## Fixed Issues

### WR-01: Memory-twin compensation re-creates a claim for a connection a concurrent removal deleted

**Files modified:** `packages/organization/src/OrganizationConnectionLifecycle.ts`, `packages/organization/src/OrganizationConnections.ts`, `packages/saml/src/SamlConnections.ts`, `packages/organization/test/OrganizationConnectionLifecycle.test.ts`, `.changeset/connection-lifecycle-module.md`
**Commit:** 8b0c7211 (requires human verification: concurrency logic, traced and unit-tested, the interleaving itself only simulated on the memory twin)
**Applied fix:** `ConnectionProtocol` gains a required `isGone(error)` predicate (OIDC: `ConnectionRecordNotFound`; SAML: `SamlConnectionNotFound`). When the write's failure says the connection is gone, the in-unit compensation releases the connection's claims instead of restoring `previous`. The reviewer suggested skipping the compensation; releasing was chosen because it also covers the other interleaving (an update whose claim landed after the removal's release, then finds the row gone), which a skip would leave orphaned. SAML `remove` now maps `SamlRecordNotFound` to `SamlConnectionNotFound` inside the unit (the lifecycle must see it); the outer `catchTag` it replaced was unreachable for `get`.
**Tests:** three memory-leg cases: update whose write releases the claims then fails NotFound (both old and new domain free for another organization afterwards), update that claimed after the removal then finds the row gone, remove losing to another removal. They fail against the previous code (3 red on memory) and pass now; the first is memory-only by construction (over SQL the simulated release is part of the rolled-back unit).
**Stale `previous`:** not fixable cleanly (it is read by the caller before the unit and passed as data; reading it under the lock would change `PreparedUpdate`, `remove`'s signature and every caller). Recorded as a documented limit in the lifecycle header ("What holds where") and in the changeset: on SQL the unit is one transaction under the lock, so nothing is restored; the memory twin has no lock and no rollback (a test double), so two fibers racing on one connection can still interleave there.
**Wording:** lifecycle header and changeset now say exactly what holds on SQL and on the memory twin; the Migration paragraph names `isGone`.

### WR-02: The connection write runs under the org-wide advisory lock and an open transaction and seals the client secret through `Encryption` / `KeyProvider`

**Files modified:** `packages/organization/src/ConnectionRecords.ts`, `packages/organization/src/OrganizationConnections.ts`, `packages/organization/src/OrganizationConnectionLifecycle.ts`, `packages/organization/test/OrganizationConnections.test.ts`, `packages/organization/test/contract/ConnectionRecords.ts`, `docs/plugin-authoring.md`, `.changeset/connection-lifecycle-module.md`
**Commit:** 0a79f215
**Applied fix:** `ConnectionRecords` gains `sealSecret(id, secret)` returning an opaque `PreparedSecret` (bound to the connection id, envelope held as `Redacted`); `create` and `update` accept it as well as the plaintext (`envelopeOf`), so every existing caller and test is unchanged. The AAD stays `organization_oauth_connection:<id>:clientSecret` (the same codec seals), a prepared secret for another id is an invariant defect (no row written), and records never hand an envelope out. The OIDC store seals in `prepare` (create, and update when the patch carries a secret; `null` still clears), before the lifecycle takes the organization lock and opens the transaction. The lifecycle header, the `Prepared` doc and `docs/plugin-authoring.md` ("Multi-statement writes") state that a protocol's write must perform no external IO.
**Tests:** a spied `Encryption` and `SqlTransaction` assert the call order `["seal", "transaction"]` on create and on update (it is `["transaction", "seal"]` against the previous code: red before, green after); a `ConnectionRecords` contract case (memory and SQL) proves a pre-sealed secret is stored sealed, opens to its plaintext, rotates through `update`, and is refused for another connection id. The OIDC sealed-column suite and the OrganizationConnections tests stay green.
**Public surface:** additive only (`sealSecret`, `PreparedSecret`, widened input types) at `@awthaq/organization/records`; noted in the changeset.

### IN-01: Swallowed compensation hides its own failures and double-logs on a poisoned Postgres transaction

**Files modified:** `packages/organization/src/OrganizationConnectionLifecycle.ts`, `packages/organization/test/OrganizationConnectionLifecycle.test.ts`
**Commit:** 05101706
**Applied fix:** the compensation is skipped when the body fails with `StoreUnavailable` (only a real backend raises it, its transaction rolls back on its own, and after a failed statement the transaction may be aborted so the compensation could only fail again and log a second error); every compensation that does run uses `Effect.ignoreCause` with a warning log, so a compensation defect can never replace the write's own failure (`Effect.ignore` handled the failure channel only). Memory-twin compensation is unchanged for domain failures. The statement-level `SqlError` is mapped to `StoreUnavailable` before it reaches the unit, which is why the guard keys on that type rather than on `SqlError`; a port-level "needs compensation" flag was weighed and not taken (it would add a `SqlTransaction` surface for a test-double concern).
**Tests:** a counting `DomainClaims` spy (memory and SQL legs): a failed write compensates once, a `StoreUnavailable` write skips the compensation, a compensation that dies leaves the write's own failure as the result. Two of the three are red against the previous code.

### IN-02: `Effect.die` on `SamlDomainTaken` in `refreshMetadata` guards a state that cannot occur (necessity)

**Files modified:** `packages/organization/src/OrganizationConnectionLifecycle.ts`, `packages/saml/src/SamlConnections.ts`, `packages/saml/src/SamlRecords.ts`, `packages/organization/test/OrganizationConnectionLifecycle.test.ts`, `packages/saml/test/contract/SamlRecords.ts`
**Commit:** 0324a09d (requires human verification: removes code, behaviour unchanged by construction and by the existing refresh tests)
**Applied fix:** the lifecycle gains `refresh(protocol, organizationId, prepare)` (gate, then the write alone, no `Taken` in its type). That alone was not enough: the `SamlDomainTaken` in the error union also came from `SamlRecords.update`, whose type always carries it. `SamlRecords` therefore gains `refresh(organizationId, id, patch)` taking a `RefreshPatch` (the `ConnectionPatch` without `emailDomains`) and typed without `SamlDomainTaken`; the memory twin has its own `Ref.modify`, and the SQL layer shares the row rewrite with `update` and skips the domain step. `refreshMetadata` calls `lifecycle.refresh` over `records.refresh`, and the `catchTag("SamlDomainTaken", Effect.die)` is gone. Runtime behaviour is unchanged (the gate, the validation order, the single row write).
**Tests:** lifecycle `refresh` (gate before prepare for an unknown and a suspended organization, the write alone, the write's value and error, no claim touched); the `SamlRecords` contract classifies `refresh` (keyed isolation, an atomic case for the rewrite and not-found/foreign, a race case against removal) on memory and SQL (SQLite and Postgres). SAML pins and the metadata refresh tests unchanged and green. `check:contract-tests` still 21.

### IN-03: The Postgres race oracle never asserts the create outcome, and nothing runs it by default

**Files modified:** `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts`, `packages/organization/test/contract/DomainClaims.ts`
**Commit:** 594a82d4
**Applied fix:** the deletion-vs-create case no longer uses wall-clock sleeps. A latch transaction holds an advisory key; a statement trigger on `organization_org` DELETE blocks on that key; the test starts the deletion and waits (polling `pg_locks`) until it is parked at the organization-row delete (so it already holds the organization lock through its order -1 hook and its transaction is uncommitted), then starts the create and waits until it is parked on the organization lock, then opens the latch. The create's outcome is asserted: `InvalidConnection` ("the organization does not exist") from the in-lock re-check, alongside `delete: ok` and zero connection, claim and owner rows. Mutation check: removing the in-lock `requireActive` from the lifecycle's create turns the case red (`create: 'ok'`); with the re-check it passed in three consecutive runs. The file header (it said "never edited after this commit") now records the strengthening. The other two cases still race on `pg_sleep` margins but assert outcome classes that hold on either side of the race. A comment on the two "opposite order" contract cases (names kept) says they can only fail on Postgres and are vacuous on the single-writer memory and SQLite legs.
**Default CI evidence:** unchanged by design (no git remote, no Postgres job to wire); the Postgres run is recorded below as run locally on the CI image, CI confirmation open.

### IN-05: `RecordsBoundary` scanner matches only the `import { ... } from` form

**Files modified:** `packages/organization/test/RecordsBoundary.test.ts`
**Commit:** cfd67eca
**Applied fix:** the scanner refuses the specifier `@awthaq/organization/records` wherever it appears in a source file outside the organization package (any import form: `import * as`, side-effect import, `export ... from`, `export *`, `import()`, `require`, template-quoted) and a `*Records` or `DomainClaims` name from the root in a named import or re-export. The scan is one function (`reachesRecords`); a new self-test pins eleven refused forms and three allowed ones. No offender in `packages/*/src`.

### IN-06: The exposed `create` trusts a caller-supplied `connectionId`

**Files modified:** `packages/organization/README.md` (the lifecycle header and the changeset carry the same sentence from the WR-01 commit)
**Commit:** e85a3af4
**Applied fix:** documented, not keyed. The precondition ("a create's `connectionId` must be freshly generated by the protocol, never another live connection's") is in the lifecycle header, the changeset Migration paragraph and the organization README, and the missing separator before `OrganizationConnectionLifecycle` is added. Keying the claim delete on protocol is not cheap: `organization_domain_claim` is keyed `(domain, connectionId)`, so a second protocol's rows for the same connection id would collide on insert instead of replacing, and `release` has no protocol argument.

## Deferred Issues

### IN-04: The store-level normaliser has no cap on domain count or length

**File:** `packages/organization/src/OrganizationConnectionLifecycle.ts:64-76`
**Commit:** 774d6688 (documentation only)
**Reason:** a 50-domain cap or length rules in the shared normaliser would newly refuse OIDC and direct-caller input inside a behaviour-preserving refactor. Recorded as follow-up `F-04-02` in `.planning/phases/04-connection-lifecycle-module/04-FINDINGS.md` with evidence, impact (3N statements under the organization lock for a non-HTTP caller, not reachable from the HTTP surface) and the suggested fix.

## Gate results

Run in the worktree checkout. Baseline is the "Phase close" section of `04-BASELINE.md`.

| Gate | Result | Baseline |
|---|---|---|
| `npx tsc -b tsconfig.json` | exit 0, no `error TS` (after every fix and at the end) | as baseline |
| `npx tsc -p tsconfig.test.json` | exit 0, no `error TS`; the same 2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts` | as baseline |
| `pnpm test` (SQLite and memory) | exit 0; Test Files 420 passed, 6 skipped (426); Tests 6676 passed, 1 expected fail, 22 skipped (6699) | 6648 passed, 21 skipped: +28 passed, +1 skipped |
| `pnpm test:bdd` | exit 0; 39 files, 1580 passed, 44 skipped, 0 failed | 1580 / 44 / 0 |
| `pnpm circular` | exit 0, no findings | as baseline |
| `pnpm lint` | exit 0; warnings only (untracked `.claude/` tree, `RequestContextSteps.ts`), none under `packages/` | as baseline |
| `pnpm format:check` | exit 0 (`npx oxfmt` run on every changed `.ts` file) | as baseline |
| `pnpm check:readmes` | exit 0 | as baseline |
| `pnpm check:transactions` | exit 0 | as baseline |
| `pnpm check:error-tags` | exit 0, 163 internal and 137 wire | 163 / 137 |
| `pnpm check:contract-tests` | exit 0, 21 plugin classes | 21 |
| `pnpm spec:verify:strict` | exit 0, PASS 32, FAIL 0, SKIP 0 (no spec doc edited, so no Revision bump) | PASS 32 |
| `pnpm knip` | exit 1 (pre-existing); filtered output: `Unused files (39)` (all `.claude/`) and the 3 `readme-quickstart.ts` rows, nothing new | identical |
| Postgres, full `pnpm test` with `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` | exit 0; Test Files 426 passed; Tests 6718 passed, 1 expected fail, 1 skipped (6720) | 6690 passed, 0 skipped |

On Postgres the one skipped test is the memory-only WR-01 case ("an update whose write finds the connection gone ... restores no claim"), skipped on the SQL leg by design (a simulated release inside the unit rolls back with it); the baseline's 0 skipped grows by that one. Neither known intermittent fired and no gate was re-run.

Targeted Postgres runs during the fixes (race file, `Contract.test.ts`, `DomainClaims.test.ts`, `OrganizationConnectionLifecycle.test.ts`, `ConnectionLifecyclePins.test.ts`, `OrganizationConnections.test.ts`, `packages/saml`, `packages/scim`) were green; the race file passed three times in a row after IN-03. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).

Verification ran in the worktree, `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch`, not in a teardown copy.

---

_Fixed: 2026-11-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
