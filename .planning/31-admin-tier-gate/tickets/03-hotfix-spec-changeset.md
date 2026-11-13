---
plan: 31-admin-tier-gate
ticket: 03
title: "Hotfix spec, traceability and changeset (BEH-EA-348)"
type: execute
wave: 2
depends_on: [02]
files_modified:
  - spec/behaviors/29-saml-sp.md
  - spec/traceability.md
  - .changeset/saml-admin-by-id-organization.md
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1521]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-348 states the read-first, ask-with-the-organization rule and the uniform answer"
    - "BEH-EA-318 no longer implies by-id operations are asked without the organization"
    - "A changeset tells hosts that `organizationId: undefined` now means 'the action in general'"
  artifacts:
    - path: "spec/behaviors/29-saml-sp.md"
      contains: "## BEH-EA-348"
    - path: ".changeset/saml-admin-by-id-organization.md"
      contains: "Migration:"
  key_links:
    - from: "spec/traceability.md"
      to: "packages/saml/test/SamlAdmin.test.ts"
      via: "§1 row for file 29 lists BEH-EA-348; §5 SamlAdmin row names the by-id matrix"
      pattern: "BEH-EA-348"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Make the spec say what ticket 02 made the code do.

Purpose: Track H ships as one PR with code, spec and changeset (`.planning/README.md` shared conventions).
Output: BEH-EA-348, an edited BEH-EA-318, traceability rows, a changeset.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.3, §6.1, §6.6)
@spec/behaviors/29-saml-sp.md (Document Control at :7-12; BEH-EA-318 at :299-331)
@spec/traceability.md (Document Control; §1 behaviour-file rows; §5 test rows; search "29-saml-sp")
@.changeset/plugin-ddl-locality.md (format; untracked, someone else's, read only)
@.changeset/admin-denied-target.md (format with Migration line)
</context>

<tasks>
<task type="auto">
  <name>Task 1: BEH-EA-348 and BEH-EA-318</name>
  <files>spec/behaviors/29-saml-sp.md</files>
  <read_first>spec/behaviors/29-saml-sp.md</read_first>
  <action>Add `## BEH-EA-348: A by-id administrative operation reads the connection first and asks the gate with its organization` after BEH-EA-318, in the file's REQUIREMENT block style. Content: get, update, delete, refresh metadata, rotate and list SP signing keys MUST read the connection first (a connection outside the ambient tenant reads as absent, BEH-EA-318) and MUST ask `canManageSaml` with that connection's `organizationId`; `organizationId` absent means "the action in general". A connection the predicate refuses, and an id that names no connection in reach, MUST be answered `404 SamlConnectionNotFound` when the administrator holds the action in general and `403 SamlActionDenied` otherwise, so the answer never depends on whether a connection the caller may not manage exists. Every refusal MUST publish exactly one `auth.admin.actionDenied` naming `saml.<action>` and, when a connection was read, its `organizationId`. A not-found answer to an administrator who holds the action spends the `adminRate` budget. A store outage during the read is `StoreUnavailable` (503) whatever the predicate. Add the Previous/Next links. In BEH-EA-318, change `canManageSaml({ admin, action, organizationId? })` prose to say create/list pass the organization the request names and by-id operations follow BEH-EA-348, and that create/list denials name `organizationId` too. Bump the Document Control revision to the next number after 1.12 and add a change-history line "(architecture plan 31 ticket 02): BEH-EA-348; BEH-EA-318 by-id operations ask with the connection's organization".</action>
  <verify><automated>grep -c "^## BEH-EA-348" spec/behaviors/29-saml-sp.md</automated></verify>
  <acceptance_criteria>
    - The grep prints 1 (baseline at HEAD: 0).
    - The Document Control revision is 1.13 or the next free number, with a plan-31 change-history line.
  </acceptance_criteria>
  <done>BEH-EA-348 written; BEH-EA-318 consistent with it.</done>
</task>

<task type="auto">
  <name>Task 2: Traceability and changeset</name>
  <files>spec/traceability.md, .changeset/saml-admin-by-id-organization.md</files>
  <read_first>spec/traceability.md, .changeset/admin-denied-target.md</read_first>
  <action>In `spec/traceability.md`: add BEH-EA-348 to the §1 row for `29-saml-sp.md`; extend the §5 row that covers `packages/saml/test/SamlAdmin.test.ts` (or add one) to name "the BEH-EA-348 by-id matrix: four predicate shapes × own/foreign/unknown × six by-id operations, the denial's organization, the throttle on not-found"; bump its Document Control revision with a plan-31 line. Create `.changeset/saml-admin-by-id-organization.md` with `"@awthaq/saml": minor` and the text and `Migration:` line of PLAN §6.6 row 1; mention that this closes a cross-organization write for delegated predicates on untenanted admin surfaces.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c "BEH-EA-348" spec/traceability.md` ≥ 2 (baseline 0).
    - `grep -c "^Migration:" .changeset/saml-admin-by-id-organization.md` → 1.
  </acceptance_criteria>
  <done>Spec verification passes; changeset present.</done>
</task>
</tasks>

<verification>
pnpm spec:verify:strict && pnpm format:check
</verification>

<success_criteria>
- BEH-EA-348 exists and is traced; the changeset carries a Migration line.
</success_criteria>

## Comments
