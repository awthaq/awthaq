---
phase: 04-connection-lifecycle-module
plan: 07
subsystem: organization
tags: [connection-lifecycle, domain-claims, records-boundary, readme]
status: complete

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-04 OrganizationConnectionLifecycle; 04-05 OIDC and 04-06 SAML stores over it
provides:
  - DomainClaims leaves the organization root export (no alias); reachable only at `@awthaq/organization/records`
  - RecordsBoundary.test.ts enforces it (non-organization src import of DomainClaims, root export)
  - withClaim and withRelease deleted; DomainClaims header names the lifecycle as the owner of the claim unit
  - organization README names the lifecycle module and the connection policy
affects: [04-08]

actuals:
  tokens: 14000
  tasks: 2
  commits: 2
plan_head_before: 965a5745070cefece973fc5224039e47bb2f84a3
plan_head_after: 4f714fe5

tech-stack:
  added: []
  patterns:
    - "A boundary test names the records-only services, so a new protocol plugin cannot claim domains without the lifecycle gate"

key-files:
  created: []
  modified:
    - packages/organization/test/RecordsBoundary.test.ts
    - packages/organization/src/index.ts
    - packages/organization/src/records.ts
    - packages/organization/src/DomainClaims.ts
    - packages/organization/test/DomainClaims.test.ts
    - features/step-definitions/OrganizationWorld.ts
    - features/step-definitions/QadiOrganizationFixture.ts
    - packages/saml/test/SamlDomainClaims.test.ts
    - packages/organization/README.md

key-decisions:
  - "Test 1 of RecordsBoundary matches `^(?:type\\s+)?DomainClaims\\b` on each imported name, so value and type imports from the root both fail"
  - "SAML README left untouched: it states neither the old suspended-organization policy nor claims released by SAML"

requirements-completed: []
---

# Phase 4 Plan 07: Close the DomainClaims seam Summary

**`DomainClaims` is gone from the organization root export, a boundary test keeps it that way, and the two sequence helpers (`withClaim`, `withRelease`) are deleted so the lifecycle is the only claim-and-write sequence.**

## Accomplishments

- Task 1 (tracer): extended RecordsBoundary.test.ts; observed red first, then removed the root export. Red assertion: `AssertionError: expected '// @awthaq/organization — Plugin (M7)…' not to match /export \* as DomainClaims\b/` at `RecordsBoundary.test.ts:51` (test "the root export no longer carries a records namespace"). Green after the removal. records.ts still exports it and its owner column now reads `OrganizationConnectionLifecycle (BEH-EA-317)`.
- Importers moved to `@awthaq/organization/records`: OrganizationWorld.ts, QadiOrganizationFixture.ts (merged into their existing sub-path import), SamlDomainClaims.test.ts (new sub-path import line). tsc named no other importer.
- Task 2: deleted `withClaim`/`withRelease` and the `SqlTransaction` import from DomainClaims.ts; rewrote the header paragraph; removed the withClaim test case from DomainClaims.test.ts (and the helper, `MemoryLayer` and imports only it used), keeping the Postgres lock block; the compensation case lives in OrganizationConnectionLifecycle.test.ts (04-04). No comment names the deleted functions (`grep -rnE '\bwith(Claim|Release)\b' packages/*/src packages/*/test features examples` = 0, was 13 rows).
- organization README: "nine system modules", the lifecycle named in the module list and in the connections paragraph (compose with `Organization.Organization` or provide `.layer` over `DomainClaims`, `OrganizationDirectory`, `SqlTransaction`; deletion removes rows, the organization releases domains; suspended organization: create and update refused, removal allowed).

## Verification (all exit 0)

- `npx tsc -b` and `npx tsc -p tsconfig.test.json`: 0 `error TS` (the two pre-existing TS377149 warnings only).
- `pnpm test`: 420 files passed | 6 skipped; 6648 tests passed | 1 expected fail | 21 skipped.
- `pnpm test:bdd` (after each task): `1580 passed | 44 skipped (1624)`, 0 failed.
- `pnpm circular`, `pnpm check:transactions`, `pnpm check:readmes`, `pnpm spec:verify:strict` (PASS 32, FAIL 0), `pnpm check:error-tags` (163 internal / 137 wire, unchanged), `pnpm lint`, `pnpm format:check`: exit 0.
- `pnpm knip`: exit 1 as in the baseline; same `Unused files (39)` (all under `.claude/`) and `Unlisted dependencies (3)`; nothing new.
- Postgres, run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote): DomainClaims lock block, OrganizationConnectionLifecycle.sql.test.ts (race file), Contract.test.ts, OrganizationConnectionLifecycle.test.ts and the whole `packages/saml` suite: 27 files, 931 tests passed, 0 failed.
- No known intermittent (passkey ChallengeStore, TenantMiddleware whoami) failed; no re-runs.

## Deviations from Plan

None - plan executed as written. The SAML README contained no sentence stating the old policy, so it was left untouched, as the plan allows.

## Known Stubs

None.

## Threat Flags

None. T-04-14 mitigated: root export removed, RecordsBoundary.test.ts fails on any non-organization src import of DomainClaims, helpers deleted.

## Self-Check: PASSED

Files verified: all nine modified files exist; commits f557d151 and 4f714fe5 are ancestors of HEAD.
