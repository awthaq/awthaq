# Phase 4: Connection-lifecycle module - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning

<domain>
## Phase Boundary

SAML and OIDC connections are created, updated and removed through one exposed organization service that owns the claim-then-connection-write sequence, parameterized by a protocol descriptor. The service keeps domain claims atomic with the connection row (BEH-EA-317), releases domains on connection delete and on organization deletion, and applies one decided suspended-organization policy. `DomainClaims` leaves the organization root export, `organization` imports no SAML types, protocol error tags and `onTaken` are preserved, `SqlTransaction` is taken as a service (`check:transactions` passes). SCIM is excluded except the shared active-organization gate and the deletion hook; the SCIM `createConnection` orphan case is recorded as a finding, not fixed here. ADR-EA-040 gets a revision line; BEH-EA-237/318 are amended; a changeset with a `Migration:` line ships.

Requirements: CONN-01..CONN-06, GATE-04.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion: this is a structural refactor with technical success criteria. The user's standing instruction is the cleanest end state, not the simplest; complexity is accepted. Already decided (REQUIREMENTS.md "Locked decisions", user-confirmed during milestone setup), not open:

- Suspended-organization gate: `findActive` on create and update for both SAML and OIDC; no check on remove. A suspended organization and a missing organization stay indistinguishable to the caller. A failing scenario in `features/**/29-saml-sp.feature` lands first (before the `src` change) and then passes; BEH-EA-237/318 are amended.
- BEH-EA-317 holds: claim first; claim and connection row atomic; the memory twin compensates (releases the claim when the connection write fails); no event is emitted for a rolled-back claim.
- The module takes `SqlTransaction` as a service so `pnpm check:transactions` passes; protocol error tags and the `onTaken` hook are preserved byte-for-byte; `organization` imports no SAML types (the protocol descriptor is supplied by the SAML/OIDC callers).
- `DomainClaims` leaves the organization root export (`packages/organization/src/index.ts`); consumers move to the new service surface.
- SCIM is out of scope except the shared gate and deletion hook; the SCIM `createConnection` orphan case is documented as a finding in the phase artifacts.
- A Postgres update-vs-remove race case asserts outcome counts (not order). Postgres is available locally through the Debian `postgres:16` container at `postgres://postgres:pw@localhost:55433/awthaq` (same image CI uses); run with `AWTHAQ_POSTGRES_URL`. Record the run and also keep the "CI confirmation open" note since hosted CI cannot run (no git remote).
- Research hypotheses to settle before planning: whether claim-then-connection ordering can deadlock between concurrent update and remove (lock-order), and where the event is emitted relative to commit.
- Changeset with a `Migration:` line for the root-export removal; ADR-EA-040 revision line; spec Revision and Change History bumped together; one candidate, one changeset.
- Wave 0 records the gate baseline and a pin matrix of today's behaviour (claim/release semantics, error tags, `onTaken`) and lands the failing suspended-org scenario before any `src` change, as in Phases 1-3.
- Strata: `api < ports < sql < core < server < qadi < plugins < cli/test/features`; `pnpm circular` counts type-only imports.
- Executors do not run `requirements.mark-complete`; verification gates that need Postgres use the local container.

### Decided autonomously
- [Policy scope] Q: "Is the suspended check a policy of the service or of each caller?" → Selected: "Of the service: one `findActive` gate on create and update inside the lifecycle module, so SAML and OIDC cannot diverge" — one decided policy is the phase goal
- [Existing public export] Q: "Keep a deprecated `DomainClaims` alias?" → Selected: "No: pre-1.0 and unpublished; remove it and record the `Migration:` line" — consistent with Phases 1 and 3
- [Open design] Q: "Service shape, descriptor fields, file layout?" → Selected: "Left to research and the planner under the cleanest-end-state rule; only a product-level or public-wire question is escalated"

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/organization/src/DomainClaims.ts`, `OrganizationConnections.ts`, `records.ts`, `OrganizationBundle.ts`, `index.ts`
- `packages/saml/src/SamlConnections.ts`, `Saml.ts`
- Tests: `packages/organization/test/{DomainClaims,OrganizationConnections,Contract}.test.ts`, `packages/organization/test/contract/DomainClaims.ts`, `packages/saml/test/SamlDomainClaims.test.ts`
- BDD: `features/step-definitions/{OrganizationWorld,QadiOrganizationFixture,TenancyWorld}.ts`; spec `spec/behaviors/29-saml-sp.md`, `spec/decisions/040-*`, `spec/models/09-sso.md`
- Phase 3 `OrganizationRecords` keyset work has landed (dependency satisfied).

### Established Patterns
- Phase process: baseline and pin matrix first, then refactor, then re-run every gate; verbatim moves; changeset with `Migration:`.

### Integration Points
- OIDC connection code (locate during research), SCIM connection code (gate and deletion hook only), organization deletion path, qadi/organization fixtures.

</code_context>

<specifics>
## Specific Ideas

None beyond the success criteria.

</specifics>

<deferred>
## Deferred Ideas

- CONN-F1: bring SCIM into the connection lifecycle if it gains domains and update (future requirement).

</deferred>
