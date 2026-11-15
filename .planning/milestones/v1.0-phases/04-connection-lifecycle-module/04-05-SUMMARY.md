---
phase: 04-connection-lifecycle-module
plan: 05
subsystem: organization
tags: [connection-lifecycle, oidc, domain-claims, postgres-races]

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-04 OrganizationConnectionLifecycle service (create, update, remove over a ConnectionProtocol)
provides:
  - OIDC store (OrganizationConnections.layerStore) as a protocol (oauthProtocol) over the lifecycle, with no gate, claim sequence or normaliser of its own
  - connectionsOnOrganizationDelete removing rows only (claims go at order -1)
  - Postgres race file fully green (3 passed)
affects: [04-06, 04-07]

actuals:
  tokens: 14000
  tasks: 2
  commits: 2
plan_head_before: 463936e16be94e1ea61f6fc9f149aa9ecae23555
plan_head_after: a065e31bc76d6461c4df792c97d36c1967c550e7

tech-stack:
  added: []
  patterns:
    - "Protocol descriptor + prepare: the store keeps validation, ids, events and cache invalidation; the lifecycle owns gate, claim, compensation, release"

key-files:
  created: []
  modified:
    - packages/organization/src/OrganizationConnections.ts
    - packages/organization/test/OrganizationConnections.test.ts
    - features/step-definitions/TenancyWorld.ts
    - .planning/phases/04-connection-lifecycle-module/04-BASELINE.md

key-decisions:
  - "OIDC remove reads the row first for its previous domains; None keeps failing ConnectionRecordNotFound"
  - "Events and map.invalidate stay in the store, after the lifecycle returns (ADR-EA-049)"

patterns-established:
  - "A store that needs the lifecycle gets OrganizationConnectionLifecycle.layer provided directly below it, above DomainClaims, SqlTransaction and the directory"

requirements-completed: []

duration: 25min
completed: 2026-11-14
status: complete
---

# Phase 4 Plan 05: OIDC store over the lifecycle Summary

**The OIDC connection store is now one `oauthProtocol` descriptor and three lifecycle calls; its own gate, claim wrapper, domain regex and normaliser are deleted, and all three Postgres race cases pass.**

## Accomplishments

- `OrganizationConnections.ts`: module-level `oauthProtocol` (`protocol: "oauth"`, refuse -> `InvalidConnection { reason }`, taken -> `ConnectionDomainTaken { domain }`). `create` and `update` pass a `prepare` effect (id, validate, `OrganizationConnectionLifecycle.normalizeDomains`, row write as an effect) to `lifecycle.create` / `lifecycle.update`; `remove` reads the row (None -> `ConnectionRecordNotFound`) then calls `lifecycle.remove` with `current.emailDomains`. Invalidation and the three events run after the lifecycle returns, at the same points as before.
- Deleted from the store: `DOMAIN`, `normalizeDomains`, `claimed`, `requireActiveOrganization`, and the `DomainClaims`, `SqlTransaction`, `OrganizationDirectory` reads and imports. `layerStore` now requires `ConnectionRecords`, `OrganizationConnections`, the lifecycle, `AuthEvents`, `SecureRandom`.
- `connectionsOnOrganizationDelete`: `inTransaction: records.removeAllForOrganization`; no `DomainClaims`; comment names the order -1 contribution.
- Standalone compositions given the lifecycle layer: `ConnectionsLive` and `ConnectionsStore` (OrganizationConnections.test.ts), `buildConnectionStack` (TenancyWorld.ts). tsc named no other composition: SamlWorld.ts, Sso.test.ts and SamlDomainClaims.test.ts needed no edit.

## Task Commits

1. Task 1 (tracer): `264c28cb` feat(04-05): route OIDC create through OrganizationConnectionLifecycle
2. Task 2: `a065e31b` refactor(04-05): OIDC update and remove through the lifecycle, store's own gate and claim copies deleted

## Verification

- Tracer gate (after Task 1): tsc clean both configs; OrganizationConnections, pins, lifecycle, SamlDomainClaims, Sso tests 67/67; race file on Postgres `1 failed | 2 passed`, the failure being update racing remove, as planned.
- After Task 2: race file on Postgres `3 passed (3)`, no StoreUnavailable; Contract + pins + lifecycle + race on Postgres `582 passed`. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote). Recorded in 04-BASELINE.md "04-05 Postgres".
- Plan grep gates: 0 code lines naming DomainClaims/SqlTransaction/requireActiveOrganization/withClaim/withRelease/`const DOMAIN`; 3 lifecycle calls; `releaseAllForOrganization` 0; `organization.oauthConnections` 1.
- `pnpm check:transactions`, `pnpm circular`, `pnpm lint`, `pnpm format:check` exit 0; `pnpm check:error-tags` 163/137 (unchanged).
- `pnpm test`: 421 files, 6649 passed (1 expected fail, 21 skipped).
- `pnpm test:bdd`: `3 failed | 1577 passed | 44 skipped (1624)`, exactly the three 04-02 SAML rows (REQ-EA-1569, 1570, 1571), red until 04-06.
- `pnpm knip`: exit 1 for baseline reasons only (3 `readme-quickstart.ts` unlisted dependencies, untracked `.claude/` files); nothing under `packages/organization`.
- No intermittent re-runs were needed. Wave 0 pin files and the race test were not edited.

## Deviations from Plan

None - plan executed exactly as written. (The Task 1 "Tenancy BDD feature" run was covered by the full `pnpm test:bdd` run in Task 2, which passes apart from the three expected SAML rows.)

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- Commits 264c28cb and a065e31b are on the branch; OrganizationConnections.ts, its test, TenancyWorld.ts and 04-BASELINE.md exist and are modified as described.
