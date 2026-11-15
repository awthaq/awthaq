---
phase: 04-connection-lifecycle-module
verified: 2026-11-14T15:45:00Z
status: passed
score: 5/5 roadmap truths verified; Postgres legs confirmed locally on Debian postgres:16 (en_US.utf8), the image CI uses
covered_files:
  - .changeset/connection-lifecycle-module.md
  - .planning/phases/04-connection-lifecycle-module/04-01-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-01-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-02-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-02-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-03-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-03-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-04-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-04-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-05-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-05-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-06-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-06-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-07-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-07-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-08-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-08-SUMMARY.md
  - .planning/phases/04-connection-lifecycle-module/04-09-PLAN.md
  - .planning/phases/04-connection-lifecycle-module/04-09-SUMMARY.md
  - packages/organization/src/DomainClaims.ts
  - packages/organization/src/OrganizationConnectionLifecycle.ts
  - packages/organization/src/OrganizationConnections.ts
  - packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts
  - packages/saml/src/SamlConnections.ts
covered_digest: "v4:sha256:7938291175e83dc6d28ec8308735c82230e52a7f6463a22ad43ec5e09fa0b641"
behavior_unverified: 0
overrides_applied: 0
human_verification: []
---

# Phase 4: Connection-lifecycle module Verification Report

**Phase Goal:** SAML and OIDC connections are created, updated and removed through one exposed organization service that keeps domain claims atomic and applies one decided suspended-organization policy.
**Verified:** 2026-11-14
**Status:** passed (every criterion verified in code at HEAD `2bd8a851`, which includes the review fixes WR-01, WR-02, IN-01..IN-06; local gates and the Postgres legs on the CI image pass, see "Postgres confirmation")
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Create/update of a SAML or OIDC connection for a suspended organization is refused, remove still works; a failing `29-saml-sp.feature` scenario landed first and now passes; BEH-EA-237/318 amended; suspended and missing organizations indistinguishable | VERIFIED | `OrganizationConnectionLifecycle.ts`: `create`, `update` and `refresh` each call `requireActive` first (`directory.findActive`, `None` for missing OR suspended, one `protocol.refuse("the organization does not exist")`); `remove` has no gate. Both stores go through it: `SamlConnections.ts` (`lifecycle.create` :315, `.update` :397, `.refresh` :454, `.remove` :507) and `OrganizationConnections.ts` (:428, :494, :573). The raw `directory.find` in SAML is gone. Feature file: scenarios REQ-EA-1569 (create, suspended vs missing give the same answer), 1570 (update), 1571 (refresh), 1572 (delete still works) in `29-saml-sp.feature`; commit `8f738ad7` (04-02, red against untouched src: 3 failed) precedes the first SAML src change `0eff61cd` (04-06). `29-saml-sp.steps.test.ts`: 109 passed; `pnpm test:bdd`: 39 files, 1580 passed, 44 skipped. Mutation read: removing `requireActive` from `create`/`update`/`refresh` makes 1569/1570/1571 fail at their exact baseline assertion (suspended create/rename/refresh would succeed), while 1572 stays green because `remove` never gates. Spec: `spec/behaviors/28-tenancy.md` Rev 1.14 -> 1.15 (BEH-EA-237 names the one gate, create/update refused, remove allowed, deletion releases claims) and `29-saml-sp.md` Rev 1.14 -> 1.15 (BEH-EA-318: refused exactly like a missing organization, delete of a suspended organization's connection succeeds); Revision and Change History bumped together. |
| 2 | Claim-then-write atomic (BEH-EA-317): failed write releases the claim in the memory twin, rolled-back claim emits no event, deleting a connection or an organization releases its domains | VERIFIED | `unit()` runs claim+write in `SqlTransaction.withTransaction`; `Effect.onError` runs the compensation inside the transaction (memory twin releases/restores; SQL rolls back as a whole); `StoreUnavailable` skips the compensation, a failing compensation never replaces the cause (`ignoreCause`); `protocol.isGone` releases instead of restoring so no claim outlives its connection. The module publishes nothing: no `AuthEvents`/publish import in `OrganizationConnectionLifecycle.ts`; events stay in the stores after `create` returns, so a rolled-back claim leaves no event. `remove` releases claims first then runs the row removal in one unit. `claimsOnOrganizationDelete` (order -1) calls `releaseAllForOrganization` inside the deletion transaction, registered in `OrganizationSystem.ts:43`. Covered by `OrganizationConnectionLifecycle.test.ts` (memory and SQLite legs; the single skipped case is the memory-only "connection removed meanwhile (sql)" twin, justified in-file because the in-unit release rolls back over SQL), `DomainClaims.test.ts`, `ConnectionLifecyclePins.test.ts`, `SamlDomainClaims.test.ts`, `OrganizationDeletion.test.ts`, all passing. |
| 3 | Postgres update-vs-remove race case asserts outcome counts and passes (superseded: run on the CI image locally) | VERIFIED | `OrganizationConnectionLifecycle.sql.test.ts` (3 cases: update racing remove of the same connection; two organizations claiming the same two domains in opposite order; deletion racing create) asserts outcome classes and `COUNT(*)` of connection, claim and owner rows via `countRows`, never fiber finish order. 3 passed on `postgres:16` Debian, repeated 5 times earlier and 3 times on a second container plus once inside the whole suite. The per-organization lock (`organization_domain_claim:org:<id>`) and sorted owner insertion are in `DomainClaims.ts`; red-first history recorded in 04-BASELINE.md (04-02, red against untouched src). |
| 4 | `DomainClaims` not exported from the organization root; organization imports no SAML types; protocol error tags and `onTaken` preserved; `check:transactions` and `check:error-tags` pass; ADR-EA-040 revision line; changeset with `Migration:` | VERIFIED | `packages/organization/src/index.ts` has no `DomainClaims` (only `OrganizationConnectionLifecycle` at :14); `records.ts:23` keeps the sub-path export; `RecordsBoundary.test.ts` enforces it. `grep -rniE "@awthaq/saml\|SamlRecords\|SamlDomainTaken\|InvalidSamlConnection" packages/organization/src` = exactly the 2 baseline comment hits (`OrganizationActor.ts:24`, `OrganizationMigrations.ts:464`); `@awthaq/saml` count in `organization/package.json` = 0. No DomainClaims reference outside organization src. Error tags: `git diff c683a1bc HEAD -- packages/*/src` touches no `TaggedError` tag line; `check:error-tags` = "163 internal and 137 wire error tags, none shared". `onTaken` is preserved in meaning: the former `withClaim(..., onTaken)` parameter is now the descriptor field `ConnectionProtocol.taken`, mapping `DomainClaimTaken` to the protocol's own `SamlDomainTaken` / `ConnectionDomainTaken` (`lifecycle.claim`), pinned by `SamlLifecyclePins.test.ts`; the literal name `onTaken` no longer exists in `src` (see note below). `check:transactions`: "no bare sql.withTransaction"; the service takes `SqlTransaction` as a service. ADR-EA-040 Rev 1.2 -> 1.3 with a Change History entry and a "Revision note (1.3)". `.changeset/connection-lifecycle-module.md` carries a `Migration:` paragraph (DomainClaims moved to `/records`, `withClaim`/`withRelease` removed, new exposed service must be added to `OrganizationServices`); `examples/{memory,sql}-server/app.ts` updated accordingly. |
| 5 | SCIM unchanged except the shared gate and deletion hook; SCIM `createConnection` orphan recorded as a finding | VERIFIED | `git diff --stat c683a1bc HEAD -- packages/scim/src packages/scim/package.json packages/scim/README.md` is empty; `git diff --name-status c683a1bc HEAD -- packages/scim` is exactly `A packages/scim/test/ScimConnectionOrphan.test.ts`. SCIM already uses `directory.findActive` (`ScimConnections.ts:143`) and contributes its own deletion hook (`Scim.ts:612`). `04-FINDINGS.md` F-04-01 records the orphan (file/line, impact: not an auth bypass, repro via `ScimConnectionOrphan.test.ts`, suggested CONN-F1), and F-04-02 records the deferred normaliser cap (review IN-04). |

**Score:** 5/5 truths verified. 0 behavior-unverified (the transition/cancellation invariants in truths 2 and 3 are exercised by named tests that pass).

### Requirements Coverage

| Requirement | Verdict | Evidence |
|-------------|---------|----------|
| CONN-01 | SATISFIED | One exposed `OrganizationConnectionLifecycle` service; SAML and OIDC both route create/update/refresh/remove through it; deletion contribution releases every claim. |
| CONN-02 | SATISFIED | One `normalizeDomains` (the two former `DOMAIN` copies are gone; `grep '^const DOMAIN'` finds one, in the lifecycle); sorted owner insertion and per-organization lock in `DomainClaims`. |
| CONN-03 | SATISFIED | Suspended policy decided once (`requireActive`), failing-first BDD landed first and is green, BEH-EA-237/318 amended, spec Rev bumped, Postgres race green. |
| CONN-04 | SATISFIED | `SqlTransaction` taken as a service; protocol descriptor supplies refusal, taken and gone errors; tags and taken-domain naming pinned; `check:transactions` and `check:error-tags` pass. |
| CONN-05 | SATISFIED | `DomainClaims` off the root export, `withClaim`/`withRelease` removed (`grep -rnE '\bwith(Claim|Release)\b' packages/*/src` empty), boundary test, no SAML import in organization. |
| CONN-06 | SATISFIED | SCIM diff is the one added test; F-04-01 recorded; ADR-EA-040 Rev 1.3; changeset with `Migration:`. |
| GATE-01..04 | SATISFIED | `04-BASELINE.md` baseline (incl. Postgres record and "Phase close" comparison) and this verification's re-runs below; knip unchanged (pre-existing, same 3 unlisted deps and untracked `.claude/` per baseline). |

No orphaned requirements: REQUIREMENTS.md maps CONN-01..06 (and the GATE rows) to this phase and every plan claims them.

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `OrganizationConnections` (OIDC) | lifecycle | `lifecycle.create/update/remove` with `oauthProtocol` | WIRED |
| `SamlConnections` | lifecycle | `lifecycle.create/update/refresh/remove` with `samlProtocol`, via `dependsOn: [Organization]` | WIRED |
| `Organization.Organization` exposed services | lifecycle layer + `claimsOnOrganizationDelete` | `OrganizationSystem.ts:32,42,43` | WIRED |
| lifecycle | `DomainClaims`, `OrganizationDirectory.findActive`, `SqlTransaction` | `Layer.effect` service requirements | WIRED |
| `DomainClaims` | organization root | not exported; sub-path `records.ts:23` only | CORRECTLY UNWIRED |
| `OrganizationDeletion` | claims release | order -1 contribution inside the deletion transaction | WIRED |

### Data-Flow Trace (Level 4)

Claims and connection rows flow from real `DomainClaims` / records stores (SQL: advisory lock + `INSERT`/`DELETE`; memory: `Ref`). The Postgres race case reads `COUNT(*)` of the connection, claim and owner tables, so the asserted counts come from real rows. No static or hollow data found.

### Behavioral Spot-Checks and Gates (run in this verification)

| Check | Command | Result |
|-------|---------|--------|
| Build | `npx tsc -b tsconfig.json` | no errors |
| Transactions | `pnpm check:transactions` | pass |
| Error tags | `pnpm check:error-tags` | 163 internal / 137 wire, none shared |
| Cycles | `pnpm circular` | no findings |
| Spec | `pnpm spec:verify:strict` | PASS 32, FAIL 0, SKIP 0 |
| 29-saml-sp BDD | `pnpm --filter @awthaq/features exec vitest run features/13-enterprise-federation/29-saml-sp.steps.test.ts` | 109 passed |
| BDD (memory) | `pnpm test:bdd` | 39 files; 1580 passed, 44 skipped |
| Structural | root export / no-SAML grep / `withClaim`-`withRelease` grep / SCIM diff | as in truths 4 and 5 |

### Probe Execution

No declared `probe-*.sh` for this phase (probe discovery found none): SKIPPED.

### Anti-Patterns Found

None blocking. No `TBD|FIXME|XXX` introduced in the phase's src files. Known limits are documented in code and in findings rather than hidden: the memory twin has no lock or rollback (a test double; documented in the lifecycle header and changeset), F-04-02 (unbounded domain count/length in `normalizeDomains`, deferred review IN-04), F-04-01 (SCIM orphan). Review dispositions: `04-REVIEW.md` 0 critical, WR-01/WR-02 fixed, IN-01..IN-03, IN-05, IN-06 fixed, IN-04 deferred and recorded; `04-SECURITY.md` SECURED 27/27.

### Notes (non-blocking)

- `onTaken` as a literal identifier no longer exists; the CONTEXT decision "protocol error tags and the `onTaken` hook are preserved" was realised by moving the hook into the descriptor (`ConnectionProtocol.taken`). Behaviour (own taken-domain error naming the first foreign domain in input order) is preserved and pinned; the changeset's Migration line documents the removal of `withClaim`/`withRelease`.
- The skipped Postgres-leg case "a connection removed meanwhile (sql)" is deliberately memory-only (explained in the test); the SQL equivalent is the race file's update-vs-remove case.

### Human Verification Required

None.

### Gaps Summary

No gaps. Every roadmap criterion is verified against the code at HEAD, not the SUMMARY claims.

---

## Postgres confirmation

Hosted CI cannot run (the repo has no git remote). The CI-equivalent run was performed locally on Debian `postgres:16` (PostgreSQL 16.16 Debian 16.16-1.pgdg13+1, `datcollate` `en_US.utf8`), the image `.github/workflows/check.yml` uses, with `AWTHAQ_POSTGRES_URL` passed explicitly.

| Run | Result |
|-----|--------|
| Race file + `organization/Contract.test.ts` + `OrganizationConnectionLifecycle.test.ts` + `DomainClaims.test.ts` + `saml/Contract.test.ts` + `SamlDomainClaims.test.ts` on the existing 04-baseline container (port 55433) | 6 files passed; 732 passed, 1 skipped (the documented memory-only case) |
| Race file `OrganizationConnectionLifecycle.sql.test.ts`, verbose | 3/3 passed: update-vs-remove, opposite-order domain claims, deletion-vs-create |
| Full `pnpm test` on the 55433 container | NOT clean, an environment failure: the container's default 64 MB `/dev/shm` was exhausted under whole-suite parallel load ("could not resize shared memory segment ... No space left on device"), a Postgres backend then segfaulted (signal 11) and the server restarted into crash recovery; 212 failures across webhooks/test/organization contract files and, as a side effect, the deletion-vs-create race case once. After recovery no source or test edit was made. |
| Same suite on a fresh throwaway `postgres:16` container with `--shm-size=1g` (port 55434, same image and `en_US.utf8`, removed afterwards) | Race file 3/3 passed three times; full `pnpm test`: 426 files passed, 6718 passed, 1 expected fail, 1 skipped, exit 0 (0 failures); `pnpm test:bdd` 39 files, 1580 passed, 44 skipped |

The 55433 failure is a Docker memory-limit artifact (the same suite is green on the same image with adequate shared memory), not a code defect; CI service containers need adequate `/dev/shm` for the same reason. The race case recorded "not run locally" in the original criterion is superseded by this run.

_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
