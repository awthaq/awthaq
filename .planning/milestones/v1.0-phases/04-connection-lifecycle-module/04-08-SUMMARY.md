---
phase: 04-connection-lifecycle-module
plan: 08
subsystem: spec
tags: [specification, changeset, connection-lifecycle, traceability]
status: complete

requires:
  - phase: 04-connection-lifecycle-module
    provides: 04-04 OrganizationConnectionLifecycle; 04-05 and 04-06 the OIDC and SAML stores over it; 04-07 DomainClaims off the root export
provides:
  - BEH-EA-317 states the lifecycle's unit as built; its known limit is closed
  - BEH-EA-318 and BEH-EA-237 state the suspended-organization connection policy; BEH-EA-235 agrees
  - ADR-EA-040 revision note 1.3 and the SSO model name the lifecycle
  - traceability rows for the lifecycle, race, pin, boundary and SCIM-orphan tests
  - changeset connection-lifecycle-module with the Migration paragraph
affects: [04-09]

actuals:
  tokens: 14000
  tasks: 2
  commits: 2
plan_head_before: b2bdb9b3b2c81b5384c4a9a89648e5d3a15599c3
plan_head_after: 2378e6e1fa11e7b0d05423ae3a79f8f149389f94

tech-stack:
  added: []
  patterns:
    - "Revision, Effective Date and the newest Change History row are bumped in one edit (spec:verify:strict check 14)"

key-files:
  created:
    - .changeset/connection-lifecycle-module.md
  modified:
    - spec/behaviors/29-saml-sp.md
    - spec/traceability.md
    - spec/behaviors/28-tenancy.md
    - spec/models/09-sso.md
    - spec/decisions/040-plugin-exposes-domain-services.md

key-decisions:
  - "Suspended and missing organizations stay indistinguishable in the wording (one refusal, 'the organization does not exist')"
  - "The traceability row for DomainClaims.test.ts is narrowed to the Postgres claim-lock test; the claim semantics are attributed to the DomainClaims RecordsContract suite, which is where they now live"

requirements-completed: []
---

# Phase 4 Plan 08: Specs and changeset up to the code Summary

**BEH-EA-317's Postgres known limit is replaced by the lifecycle's guarantee (one unit, advisory lock, sorted owner rows, claims first on removal, create re-check), BEH-EA-318/237/235 state that a suspended organization's SAML and OIDC connections cannot be created, updated or refreshed but can be removed, and a changeset carries the migration.**

## Accomplishments

- Task 1 (tracer, commit ca905620): 29-saml-sp 1.14 to 1.15. BEH-EA-317's sentence "Postgres relies on the owner row's primary key, not on a lock" is gone; the paragraph names `OrganizationConnectionLifecycle`, the lock key `organization_domain_claim:org:<organizationId>`, sorted insert order, claims-before-row on removal, the create re-check, the memory twin's in-unit compensation, no event for a rolled-back claim, and the seven tests. BEH-EA-318's REQUIREMENT gained the suspended-organization clause and names REQ-EA-1569 to 1572 (read from the feature file). traceability 1.92 to 1.93: row 227 narrowed, five rows added (lifecycle test, Postgres race file, the two pin files, RecordsBoundary) plus ScimConnectionOrphan.test.ts as a characterization of F-04-01 (CONN-F1), not a behavior.
- Task 2 (commit 2378e6e1): 28-tenancy 1.14 to 1.15 (BEH-EA-237 clause; BEH-EA-235 names the shared gate, removal needing no active organization, deletion releasing claims), 09-sso 1.2 to 1.3, ADR-EA-040 1.2 to 1.3 with "Revision note (1.3)", and `.changeset/connection-lifecycle-module.md` (`@awthaq/organization` and `@awthaq/saml` minor) with a `Migration:` paragraph covering the root-export removal (use `@awthaq/organization/records`), `withClaim`/`withRelease` removal, the new exposed key `awthaq/plugin/organization/ConnectionLifecycle` (compositions naming the exposed services by type add it; `layerStore` without `Organization.Organization` provides the lifecycle layer), the suspended-organization policy change, the Postgres lock behaviour, and `connectionsOnOrganizationDelete` no longer releasing claims.

## Verification

- `pnpm spec:verify:strict`: PASS 32, FAIL 0, SKIP 0 (after each task). `python3 features/scripts/allocate-req-ea.py --check`: 1361 scenario rows, manifest current.
- `pnpm check:readmes`, `pnpm format:check`, `pnpm check:error-tags` (163 internal / 137 wire), `pnpm lint`: exit 0 (lint warnings are pre-existing, in untracked `.claude/` and `features/step-definitions`).
- `git diff --name-only` over the two commits lists only the six plan files. No code changed, so `tsc` was not run.

## Deviations from Plan

**1. [Wording] Error name** - the plan says `InvalidSamlConnection`; the endpoint answers `InvalidSamlConnectionRequest` (the feature scenarios use that name) and the store raises `InvalidSamlConnection`. The spec and changeset name both. Files: 29-saml-sp.md, changeset. Commit: ca905620, 2378e6e1.

**2. [Accuracy] DomainClaims.test.ts row** - the plan said it "now holds the Postgres lock test"; the row text was rewritten to match what the file contains after 04-07 (only the lock block), with the claim semantics attributed to the DomainClaims RecordsContract suite. Commit: ca905620.

**3. [Scope note] Documents' current revisions matched the plan** (29-saml-sp 1.14, 28-tenancy 1.14, 09-sso 1.2, ADR-EA-040 1.2, traceability 1.92); no re-basing was needed. `spec/traceability.md`'s pre-existing numbering gap was not touched. oxfmt ignores `**/*.md` in this repo, so `npx oxfmt` on the markdown files is a no-op; `pnpm format:check` passes.

## Known Stubs

None.

## Threat Flags

None. T-04-15 mitigated: the policy, the removed exports and the new service key are named in the specs and the changeset; spec:verify:strict ties every cited test path to the tree.

## Self-Check: PASSED

Files verified: all six plan files exist; commits ca905620 and 2378e6e1 are ancestors of HEAD.
