---
plan: 31-admin-tier-gate
ticket: 04
title: "Hotfix BDD: REQ-EA-1520, REQ-EA-1521"
type: execute
wave: 3
depends_on: [03]
files_modified:
  - features/features/13-enterprise-federation/29-saml-sp.feature
  - features/step-definitions/SamlFederationSteps.ts
  - features/traceability.md
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1521]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A scenario shows a delegated administrator refused (as not found) on another organization's connection, which stays unchanged"
    - "A scenario shows a strictly delegated administrator renaming its own organization's connection by id"
  artifacts:
    - path: "features/features/13-enterprise-federation/29-saml-sp.feature"
      contains: "@REQ-EA-1520"
  key_links:
    - from: "features/features/13-enterprise-federation/29-saml-sp.feature"
      to: "features/step-definitions/SamlFederationSteps.ts"
      via: "Given the administrator gate admits only {string} …"
      pattern: "admits only"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Acceptance scenarios for BEH-EA-348, in the SAML feature.

Purpose: BDD-003 (every behaviour change has a scenario where a feature file exists).
Output: a `@BEH-EA-348` Rule with two scenarios tagged `@REQ-EA-1520` and `@REQ-EA-1521`, their steps, the regenerated manifest, §6 rows in `spec/traceability.md`.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§6.5)
@features/features/13-enterprise-federation/29-saml-sp.feature (lines 630-690: the BEH-EA-318 Rule)
@features/step-definitions/SamlFederationSteps.ts (lines 1195-1460: `configure`, "the administrator gate allows every action", "the connection {string} exists", "a second organization {string} exists")
@features/scripts/allocate-req-ea.py (header: how tags are kept)
@features/STYLE.md
</context>

<tasks>
<task type="auto">
  <name>Task 1: Scenarios and steps</name>
  <files>features/features/13-enterprise-federation/29-saml-sp.feature, features/step-definitions/SamlFederationSteps.ts</files>
  <read_first>features/STYLE.md, features/step-definitions/SamlFederationSteps.ts</read_first>
  <action>After the BEH-EA-318 Rule, add a comment line pointing at `spec/behaviors/29-saml-sp.md` and a `@BEH-EA-348` Rule "A by-id administrative operation reads the connection first and asks the gate with its organization" with two scenarios, hand-tagged. `@REQ-EA-1520` "An administrator delegated to one organization cannot reach another organization's connection by id": Given the connection "acme" exists, And a second organization "globex" with its own connection exists, And the administrator gate admits only "acme" and the action in general; When the administrator renames the connection of "globex" by its id (no tenant); Then the rename is refused as "SamlConnectionNotFound", exactly as for an unknown id; And a refusal published auth.admin.actionDenied naming "saml.updateConnection" and the organization "globex"; And the connection of "globex" is unchanged. `@REQ-EA-1521` "An administrator delegated strictly to one organization manages that organization's connection by id": Given the connection "acme" exists, And the administrator gate admits only "acme"; When the administrator renames the connection "acme" to "Acme SSO" by its id; Then the connection "acme" is named "Acme SSO"; And reading an unknown connection id is refused as "SamlActionDenied". Implement only the new steps in `SamlFederationSteps.ts`, reusing `configure` and the world's existing organization/connection bookkeeping; the predicate steps build `canManageSaml` closures over the world's organization ids (delegated: `organizationId === undefined || organizationId === acme`; strict: `organizationId === acme`). Reuse existing step texts wherever one already says the same thing.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>
    - `grep -c "@REQ-EA-152[01]" features/features/13-enterprise-federation/29-saml-sp.feature` → 2 (baseline 0).
    - `pnpm test:bdd` passes.
  </acceptance_criteria>
  <done>Both scenarios pass against ticket 02's code.</done>
</task>

<task type="auto">
  <name>Task 2: Manifest and traceability</name>
  <files>features/traceability.md, spec/traceability.md</files>
  <read_first>features/scripts/allocate-req-ea.py, spec/traceability.md</read_first>
  <action>Run `python3 features/scripts/allocate-req-ea.py` (it keeps the hand tags and regenerates `features/traceability.md`). In `spec/traceability.md` §6, update the crosswalk row for file 29 to list REQ-EA-1520 and REQ-EA-1521 and its scenario count; add a Document Control change-history line (plan 31 ticket 04).</action>
  <verify><automated>python3 features/scripts/allocate-req-ea.py --check && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c "REQ-EA-1520" features/traceability.md` ≥ 1 and `grep -c "REQ-EA-1520" spec/traceability.md` ≥ 1 (baselines 0).
  </acceptance_criteria>
  <done>Allocator check and spec verification pass; Track H is complete.</done>
</task>
</tasks>

<verification>
pnpm test:bdd && python3 features/scripts/allocate-req-ea.py --check && pnpm spec:verify:strict && pnpm format:check
</verification>

<success_criteria>
- Two new scenarios, tagged 1520 and 1521, pass.
- Track H (tickets 01–04) is reviewable and mergeable as one PR.
</success_criteria>

## Comments
