---
phase: 04-connection-lifecycle-module
plan: 04
subsystem: organization
tags: [connection-lifecycle, domain-claims, suspended-organization-gate, template-method, exposed-service]

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-03 DomainClaims per-organization lock and sorted owner acquisition
provides:
  - OrganizationConnectionLifecycle exposed service (key awthaq/plugin/organization/ConnectionLifecycle) with create, update and remove over a ConnectionProtocol descriptor
  - normalizeDomains (the single domain normaliser, refusal worded by the protocol)
  - claimsOnOrganizationDelete deletion contribution (id organization.domainClaims, order -1) registered in OrganizationSystem.layer
affects: [04-05, 04-06, 04-07]

actuals:
  tokens: 20000
  tasks: 2
  commits: 2
plan_head_before: 07b93edd847102981122972cddb871b6e0d52b2d
plan_head_after: c10b321df6aae94ab029d4042609584f1e342576

tech-stack:
  added: []
  patterns:
    - "Template-method service: the caller supplies prepare (validation, id, row write as an effect), the module owns gate, claim, compensation, release"
    - "Compensation runs inside the SqlTransaction effect (Effect.onError within withTransaction): memory twin gives the claim back, a real transaction rolls it back"
    - "Taken-domain error mapped to the protocol's own error at the claim call (non-generic error union), not on the generic transaction result"

key-files:
  created:
    - packages/organization/src/OrganizationConnectionLifecycle.ts
    - packages/organization/test/OrganizationConnectionLifecycle.test.ts
  modified:
    - packages/organization/src/OrganizationSystem.ts
    - packages/organization/src/index.ts
    - packages/organization/test/AuthComposition.test.ts
    - features/step-definitions/OrganizationWorld.ts
    - features/step-definitions/QadiOrganizationFixture.ts
    - examples/memory-server/app.ts
    - examples/sql-server/app.ts

key-decisions:
  - "Taken-domain mapping happens inside the unit, on claims.claim's concrete error union (DomainClaimTaken | StoreUnavailable); mapping on the generic transaction result left DomainClaimTaken in the narrowed type (no `as` allowed in src)"
  - "remove takes protocol: ConnectionProtocol<unknown, unknown> (only the stored name is needed to re-claim previous)"
  - "update with domains undefined returns the write alone: no claim, no transaction, as before"

patterns-established:
  - "Exposed organization service pinned in AuthComposition.test.ts (nine modules) and named in the World/example service unions tsc demands"

requirements-completed: []

duration: 15min
completed: 2026-11-14
status: complete
---

# Phase 4 Plan 04: Connection lifecycle service Summary

**OrganizationConnectionLifecycle: one exposed organization service owning the suspended-organization gate, claim-then-write atomicity with in-transaction compensation, claims-first removal, the single domain normaliser and the order -1 claim release on organization deletion, parameterised by a protocol descriptor (no store uses it yet).**

## Accomplishments

- `packages/organization/src/OrganizationConnectionLifecycle.ts`: `ConnectionProtocol`, `Prepared`, `PreparedUpdate`, `normalizeDomains`, `OrganizationConnectionLifecycleShape`, the service (static `layer` requiring `DomainClaims`, `OrganizationDirectory`, `SqlTransaction`) and `claimsOnOrganizationDelete`.
- Create: `findActive` gate (missing and suspended refuse identically with `protocol.refuse("the organization does not exist")`) -> `prepare` -> one transaction of claim, in-lock `findActive` re-check, write; `Effect.onError` releases inside the unit. Update: same gate; domains undefined runs the write alone; otherwise claim then write, compensation re-claims `previous` inside the unit. Remove: no gate, release then write, compensation re-claims `previous`.
- Exposed in `OrganizationSystem.services` and merged (with `claimsOnOrganizationDelete`) into `OrganizationSystem.layer`; root export `OrganizationConnectionLifecycle`.
- 28 test cases (14 per leg: memory and SQL records) in `OrganizationConnectionLifecycle.test.ts`, covering every behavior of both tasks, including the moved compensation case, claims-first removal observed from inside `write`, the order -1 release on `OrganizationDirectory.delete`, and no audit rows from any lifecycle call.

## Task Commits

1. Task 1: `a6f147c5` feat(04-04): expose OrganizationConnectionLifecycle with the gated, claim-then-write create path
2. Task 2: `c10b321d` test(04-04): prove update, remove, the normaliser and the order -1 release on deletion

## Verification

- `tsc -b tsconfig.json` and `tsc -p tsconfig.test.json`: no errors (only the pre-existing TS377149 warnings in TestingHarnessSteps.ts).
- Lifecycle test: 28/28 on memory and SQLite; Postgres leg run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote): lifecycle test plus Contract.test.ts 565/565.
- `ConnectionLifecyclePins`, `OrganizationConnections`, `AuthComposition`, `OrganizationDeletion`, `DomainClaims`: pass. Wave 0 pin files and race file unchanged (`git diff --stat HEAD` empty).
- `pnpm check:transactions`, `pnpm circular`, `pnpm lint`, `pnpm format:check`, `pnpm check:contract-tests` (21): exit 0. `pnpm check:error-tags`: 163 internal / 137 wire (baseline).
- No-SAML grep over `packages/organization/src`: 2 lines (baseline); no `sql.withTransaction` or SAML identifier in the new module's code.
- `pnpm knip`: exit 1 for the pre-existing reasons only (39 untracked `.claude/` unused files, 3 `readme-quickstart.ts` unlisted dependencies); no row under `packages/`; the new exports are consumed by OrganizationSystem and the test, so nothing transient to record.
- `pnpm test`: 421 files passed, 6649 tests passed (1 expected fail, 21 skipped).
- `pnpm test:bdd`: `3 failed | 1577 passed | 44 skipped (1624)`, the three failures exactly the 04-02 rows (REQ-EA-1569, 1570, 1571) per the red window until 04-06.
- Race file (`OrganizationConnectionLifecycle.sql.test.ts`): not re-run; cases 1 and 3 stay red until 04-05 migrates the OIDC store, as planned.
- No intermittent re-runs were needed.

## tsc-named union files (RESEARCH assumption A2, resolved by tsc)

`OrganizationConnectionLifecycle.OrganizationConnectionLifecycle` added to the service unions in:
- `features/step-definitions/OrganizationWorld.ts`
- `features/step-definitions/QadiOrganizationFixture.ts`
- `examples/memory-server/app.ts`
- `examples/sql-server/app.ts`

`features/step-definitions/TenancyWorld.ts` needed no change (tsc did not name it).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The exposed-key manifest pin lists the services**
- **Found during:** Task 1 (running AuthComposition.test.ts from the plan's verify command)
- **Issue:** The plan's probe record states no test pins the exposed key list; `packages/organization/test/AuthComposition.test.ts` does ("exposes its eight system modules ...", deep-equals the manifest `exposes` keys), so exposing the ninth service failed it.
- **Fix:** Added `"ConnectionLifecycle"` to the expected list (after `Deletion`, the position of the new `services` entry) and renamed the case to "nine system modules". It is not a Wave 0 pin file.
- **Files modified:** packages/organization/test/AuthComposition.test.ts
- **Commit:** a6f147c5

**2. [Rule 1 - type shape] Taken mapping moved from the transaction result to the claim call**
- **Found during:** Task 1 (tsc)
- **Issue:** Mapping `DomainClaimTaken` with `Effect.mapError` on the generic `withTransaction` result left `DomainClaimTaken` in the inferred error union, not assignable to the shape's `Refused | Taken | E | EP | StoreUnavailable` (and `as` is forbidden in `packages/*/src`).
- **Fix:** A local `claim` helper maps `DomainClaimTaken` to `protocol.taken(domain)` on `claims.claim`'s concrete error union, inside the unit; observable behavior is identical (the error still leaves the transaction and triggers the in-unit compensation).
- **Files modified:** packages/organization/src/OrganizationConnectionLifecycle.ts
- **Commit:** a6f147c5

### Notes

- `spec/models/14-organization.md` change-history text still says "the eight system modules" (a dated history row, not a pin); left untouched, to be revisited by the phase's documentation plan if it wants to.
- Task 1 and Task 2 acceptance `grep -c 'export \* as OrganizationConnectionLifecycle'` = 1 and the other plan counts hold.

## Known Stubs

None.

## Threat Flags

None: the module adds no network endpoint or schema; T-04-07/08/09 mitigations are implemented here (single gate, identical refusals, compensation, in-lock re-check, order -1 release) and proved by the unit cases; race case 3 goes green in 04-05.

## Self-Check: PASSED

- packages/organization/src/OrganizationConnectionLifecycle.ts, packages/organization/test/OrganizationConnectionLifecycle.test.ts: present
- commits a6f147c5, c10b321d: present on HEAD
