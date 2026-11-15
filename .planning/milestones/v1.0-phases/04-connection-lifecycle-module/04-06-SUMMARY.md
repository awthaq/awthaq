---
phase: 04-connection-lifecycle-module
plan: 06
subsystem: saml
tags: [connection-lifecycle, saml, domain-claims, suspended-organization, bdd]

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-04 OrganizationConnectionLifecycle service; 04-05 OIDC store over it; 04-02 red BDD scenarios
provides:
  - SAML store (SamlConnections.layerStore) as a protocol (samlProtocol) over the lifecycle, with no gate, claim sequence, regex or normaliser of its own
  - samlOrganizationDeletion removing rows only (claims go at order -1)
  - BEH-EA-318 gate on SAML create, update and metadata refresh; removal still allowed
  - BDD red window closed (pnpm test:bdd green: 1580 passed, 44 skipped, 0 failed)
affects: [04-07]

actuals:
  tokens: 16000
  tasks: 2
  commits: 2
plan_head_before: edfac265615178ce3a97e2b70f7bd8798f027e07
plan_head_after: 11241071623231f91547d2581b60738360500438

tech-stack:
  added: []
  patterns:
    - "Protocol descriptor + prepare: the store keeps validation, ids and signing keys; the lifecycle owns gate, claim, compensation, release"
    - "Build the row write as a const before returning the prepared object, so its error type is not contextually widened to unknown"

key-files:
  created: []
  modified:
    - packages/saml/src/SamlConnections.ts
    - packages/saml/src/Saml.ts
    - .planning/phases/04-connection-lifecycle-module/04-BASELINE.md

key-decisions:
  - "SqlTransaction stays in the SAML plugin's `ports`: tsc rejects the drop (RESEARCH A1)"
  - "refreshMetadata keeps Effect.catchTag(SamlDomainTaken, Effect.die) around the lifecycle call: with domains undefined the lifecycle cannot claim"
  - "ensureSigningKey stays after the lifecycle returns, outside the claim unit"

patterns-established:
  - "A plugin whose layer type names an organization service gets an exported type alias for it (TS2883), as RecordsEncryption does"

requirements-completed: []

duration: 30min
completed: 2026-11-14
status: complete
---

# Phase 4 Plan 06: SAML store over the lifecycle Summary

**The SAML connection store is now one `samlProtocol` descriptor and four lifecycle calls; a suspended organization can no longer gain, update or refresh a SAML connection (it can still delete one), and the BDD red window is closed.**

## Accomplishments

- `SamlConnections.ts`: module-level `samlProtocol` (`protocol: "saml"`, refuse -> `InvalidSamlConnection { reason }`, taken -> `SamlRecords.SamlDomainTaken { domain }`). `create` passes its validation (name through the id) as `prepare` to `lifecycle.create`; `update` and `refreshMetadata` call `get(id)` first (NotFound before the gate), then `lifecycle.update`; `remove` does `get(id)` then `lifecycle.remove` with `current.emailDomains`. `ensureSigningKey` stays after the lifecycle returns.
- Deleted from the store: `DOMAIN`, the local `normalizeDomains` (now `OrganizationConnectionLifecycle.normalizeDomains(samlProtocol, ...)`), `claimed`, the raw `directory.find` gate, the `DomainClaims`, `SqlTransaction` and `OrganizationDirectory` reads and imports. The `layerStore` doc comment lists the new requirements.
- `Saml.ts`: `samlOrganizationDeletion` removes rows only (keeps its `SamlRecordNotFound` tolerance); the comment points at the order -1 contribution. `DomainClaims` import removed. `packages/saml/src` no longer names `DomainClaims` anywhere (code or comment).
- `SqlTransaction` stays in the plugin's `ports`: removing it makes tsc fail with `declare these required ports: awthaq/ports/SqlTransaction` (TS2769 at the `AuthPlugin.layer` call, plus knock-on errors in `SamlWorld.ts` and `FirstPartyComposition.ts`), so it was restored (RESEARCH A1). The store no longer reads it; `SamlRecords` still depends on it through `SqlTransaction.transactional`.
- Error precedence kept: create refuses an unknown or suspended organization before any validation (the old `directory.find` position); update and refresh answer NotFound for an unknown id before the gate. Protocol error tags and the taken domain are unchanged (pins pass); no new error tags (163 / 137).

## Task Commits

1. Task 1 (tracer): `0eff61cd` feat(04-06): route SAML create through OrganizationConnectionLifecycle
2. Task 2: `11241071` refactor(04-06): SAML update, refresh and remove through the lifecycle

## Verification

- Tracer gate (after Task 1): tsc clean both configs; pins, connections, admin, domain-claims, composition tests 41/41; the 29-saml-sp feature `Tests  2 failed | 107 passed (109)` (REQ-EA-1570 and 1571 still red, as planned).
- After Task 2: `packages/saml/test` 358/358; organization lifecycle pins and service tests 42/42; `pnpm test:bdd` exit 0, `Tests  1580 passed | 44 skipped (1624)`, 0 failed (REQ-EA-1569, 1570, 1571 green; REQ-EA-1572 still green). The Wave 0 scenarios, steps, pins and race test were not edited.
- Plan grep gates: 0 code lines naming DomainClaims/SqlTransaction/OrganizationDirectory/withClaim/withRelease/`const DOMAIN`/`directory.find(` in SamlConnections.ts; 4 lifecycle calls (create, update, refresh, remove); 0 `DomainClaims` / `claims.release` in Saml.ts; `grep -rl DomainClaims packages/saml/src` 0.
- Postgres (run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)): SamlLifecyclePins, SamlDomainClaims, OrganizationConnectionLifecycle.sql: 3 files, 13 tests passed.
- Full gates: `pnpm test` 421 files / 6649 passed (1 expected fail, 21 skipped); `check:transactions`, `circular`, `lint` (warnings only under untracked `.claude/`), `format:check` exit 0; `check:error-tags` 163 / 137; `knip` baseline only (no row under `packages/`). Recorded in 04-BASELINE.md "04-06 Postgres and gates" and "BDD red window".
- No intermittent test failures occurred; no re-runs were needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TS2883 on the SAML plugin layer after Task 1**
- **Found during:** Task 1 (tsc)
- **Issue:** `Saml.layer`'s inferred type could not be named without `OrganizationConnectionLifecycle` in scope.
- **Fix:** an exported type alias `ConnectionLifecycle` in `Saml.ts` (the same trick as `RecordsEncryption`) with a `type` import.
- **Files modified:** packages/saml/src/Saml.ts
- **Commit:** `0eff61cd`

**2. [Rule 3 - Blocking] Lifecycle error type inferred as `unknown` in update and refresh**
- **Found during:** Task 2 (tsc)
- **Issue:** an inline `write: records.update(...).pipe(catchTag(... Effect.fail ...))` inside the returned object literal was contextually widened.
- **Fix:** the write is a `const` built before the return. Refresh also binds the lifecycle call to a const before the `catchTag` so the call reads `lifecycle.update(` (the plan's four-call grep).
- **Files modified:** packages/saml/src/SamlConnections.ts
- **Commit:** `11241071`

**3. Plan instruction not satisfiable: drop `SqlTransaction` from `ports`**
- The plan allowed the drop only if tsc accepted; it did not, so the port stays (see Accomplishments). No other deviation.

## Known Stubs

None.

## Threat Flags

None. T-04-12 and T-04-13 mitigated: all four SAML writes go through the lifecycle; a missing and a suspended organization give one reason ("the organization does not exist").

## Self-Check: PASSED

- packages/saml/src/SamlConnections.ts and Saml.ts exist and carry the changes; commits `0eff61cd` and `11241071` are ancestors of HEAD.
