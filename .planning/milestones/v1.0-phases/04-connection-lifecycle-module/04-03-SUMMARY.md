---
phase: 04-connection-lifecycle-module
plan: 03
subsystem: database
tags: [postgres, advisory-lock, domain-claims, deadlock, race-test, contract-tests]

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-02 failing-first BDD rows and the Postgres race oracle
provides:
  - DomainClaims.layerSql claim, release and releaseAllForOrganization serialised per organization by SqlStore.atomically (organization_domain_claim:org:<id>)
  - sorted two-phase owner acquisition in claim, refused domain still named in input order
  - Postgres-only pg_locks proof of the lock key
  - three additive concurrent DomainClaims contract cases (memory, SQLite, Postgres)
  - race case 2 (opposite-order claims) green on Postgres
affects: [04-04, 04-05, 04-07]

actuals:
  tokens: 9000
  tasks: 2
  commits: 2
plan_head_before: 2a8d2fab22c8f4e71578922b1b198938db1ae21b
plan_head_after: 3f6511e77972c0bd893303c7b6886b2611e7c700

tech-stack:
  added: []
  patterns:
    - "Store primitive write wrapped in SqlStore.atomically(sql, `<table>:org:<id>`) (ADR-EA-041 decision 9), as MembershipRecords and TeamRecords do"
    - "Owner rows inserted in one sorted order for every caller, then read in the caller's order, so a deadlock-free acquisition keeps the named refusal"

key-files:
  created: []
  modified:
    - packages/organization/src/DomainClaims.ts
    - packages/organization/test/DomainClaims.test.ts
    - packages/organization/test/contract/DomainClaims.ts
    - .planning/phases/04-connection-lifecycle-module/04-BASELINE.md

key-decisions:
  - "Lock key is organization-level (organization_domain_claim:org:<organizationId>), a superset of RESEARCH's connection-level key; it cleared race case 2 as the plan expected"
  - "The new concurrent contract cases are `race` entries (the RecordsContract array that races CONCURRENCY callers), not `atomic`"

patterns-established:
  - "Postgres lock-key proof: after the operation inside sql.withTransaction, count pg_locks advisory rows for hashtextextended(key, 0) held by pg_backend_pid()"

requirements-completed: []

duration: 25min
completed: 2026-11-14
status: complete
---

# Phase 4 Plan 03: DomainClaims organization lock and sorted owner acquisition Summary

**DomainClaims.layerSql now takes an organization-scoped Postgres advisory lock around claim, release and release-all (`SqlStore.atomically`) and inserts owner rows in sorted order while still refusing on the first foreign domain in input order; the opposite-order race case is green on Postgres 16.**

## Performance

- **Duration:** about 25 min
- **Tasks:** 2
- **Files:** 4 modified (one src file, two test files, 04-BASELINE.md); no new files

## Accomplishments

- `DomainClaims.ts`: local `lockKey(organizationId)`; the three `SqlTransaction.transactional(sql)` wrappers replaced by `SqlStore.atomically(sql, lockKey(...))`; `claim` inserts owner rows over `input.domains.toSorted()` then reads owners in input order. `DomainClaimsShape`, memory twin, operation labels, `withClaim`/`withRelease` untouched. Module header documents the lock.
- `DomainClaims.test.ts`: Postgres-only "the claim lock" block (suite `organization_DomainClaimsLock`), three cases proving via `pg_locks` that org-1 holds `organization_domain_claim:org:org-1` and not org-2's after claim, release and releaseAllForOrganization.
- Contract: three `race` cases (same-organization opposite orders all succeed; two organizations in opposite order leave one owner for both domains with no StoreUnavailable; interleaved release and claim leave no orphan).
- Results (Postgres: run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): race file `-t 'opposite'` passes (`Tests 1 passed | 2 skipped (3)`); full race file `2 failed | 1 passed`, cases 1 and 3 still red with unchanged messages (they await 04-05); DomainClaims/Contract/Pins on Postgres `549 passed`; Contract.test.ts on Postgres 537 passed three runs in a row; memory and SQLite quick run `567 passed | 3 skipped`; contract-only `536 passed`; `check:contract-tests` 21 classes.
- Gates: `tsc -b`, `check:transactions`, `check:error-tags` (163 / 137), `circular`, `lint`, `format:check` all exit 0. `pnpm test:bdd`: `3 failed | 1577 passed | 44 skipped (1624)`, red by exactly REQ-EA-1569, 1570, 1571 (the BDD red window), no other failure.
- Wave 0 pin files and the race file byte-unchanged; contract file diff against c683a1bc has 0 removed lines.

## Task Commits

1. **Task 1: organization lock, sorted acquisition, lock-key proof** - `c5c1bbd8` (feat)
2. **Task 2: additive concurrent contract cases** - `3f6511e7` (test)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Concurrent cases placed under `race`, not `atomic`**
- **Found during:** Task 2
- **Issue:** The plan says "concurrent (`atomic`) cases"; in `RecordsContract` the concurrent runner array is `race` (the existing "8 organizations racing" case lives there), while `atomic` entries are sequential.
- **Fix:** Added the three cases to the `race` array of `claim`, same as the model case. Additions only.
- **Files modified:** packages/organization/test/contract/DomainClaims.ts
- **Commit:** 3f6511e7

No intermittent failures occurred (no re-runs needed).

## Known Stubs

None.

## Threat Flags

None. T-04-05 (deadlocks as StoreUnavailable) mitigated by the lock and sorted inserts, proved by race case 2 and the contract cases; T-04-06 unchanged (owner-row primary key still the arbiter, refusal before any claim row is written, 04-01 contract case and pins unchanged and green).

## Self-Check: PASSED

- FOUND: packages/organization/src/DomainClaims.ts, packages/organization/test/DomainClaims.test.ts, packages/organization/test/contract/DomainClaims.ts
- FOUND commits: c5c1bbd8, 3f6511e7
