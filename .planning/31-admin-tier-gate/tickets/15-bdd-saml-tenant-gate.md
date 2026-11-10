---
plan: 31-admin-tier-gate
ticket: 15
title: "BDD: a tenant's configuration tightens the SAML admin gate (REQ-EA-1522)"
type: execute
wave: 5
depends_on: [04, 13]
files_modified:
  - features/features/13-enterprise-federation/29-saml-sp.feature
  - features/step-definitions/SamlFederationSteps.ts
  - features/traceability.md
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1522]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A scenario shows a build-time gate that allows everything refused inside a tenant whose SAML configuration denies"
  artifacts:
    - path: "features/features/13-enterprise-federation/29-saml-sp.feature"
      contains: "@REQ-EA-1522"
  key_links:
    - from: "features/step-definitions/SamlFederationSteps.ts"
      to: "packages/saml/src/SamlConfig.ts"
      via: "Effect.provide(SamlConfig.config({ baseUrl, canManageSaml: deny })) around the request"
      pattern: "canManageSaml"
---
Status: ready-for-agent
Blocked by: 04, 13

<objective>
An acceptance scenario for ticket 08's per-tenant SAML gate.

Purpose: BEH-EA-318's per-operation rule is user-visible (ADR-EA-018 D8); BDD-003 wants a scenario.
Output: one scenario under the `@BEH-EA-318` Rule tagged `@REQ-EA-1522`, its steps, the regenerated manifest and §6 rows.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§6.5)
@features/features/13-enterprise-federation/29-saml-sp.feature (BEH-EA-318 Rule :630-690, BEH-EA-348 Rule from ticket 04)
@features/step-definitions/SamlFederationSteps.ts (`configure` and the admin steps :1195-1460)
@packages/saml/test/SamlAdmin.test.ts (ticket 08's per-tenant cases: how the tenant configuration is provided)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Scenario and steps</name>
  <files>features/features/13-enterprise-federation/29-saml-sp.feature, features/step-definitions/SamlFederationSteps.ts</files>
  <read_first>features/step-definitions/SamlFederationSteps.ts, features/STYLE.md</read_first>
  <action>Under the `@BEH-EA-318` Rule add, hand-tagged `@REQ-EA-1522`, "A tenant's configuration tightens the SAML administrator's gate per request": Given the administrator gate allows every action; And the connection "acme" exists; And the tenant "acme" configures a SAML administrator gate that denies every action; When the administrator acting inside "acme" lists the connections of "acme"; Then the listing is refused as "SamlActionDenied"; And outside any tenant the same administrator lists one connection of "acme". Implement the new steps by running the request with the tenant's `SamlConfig.config({ baseUrl: <the world's baseUrl>, canManageSaml: () => Effect.succeed(false) })` provided around it and the tenant set to acme's organization id, as ticket 08's unit cases do. Reuse existing step texts where they exist.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>
    - `grep -c "@REQ-EA-1522" features/features/13-enterprise-federation/29-saml-sp.feature` → 1 (baseline 0).
  </acceptance_criteria>
  <done>Scenario passes.</done>
</task>

<task type="auto">
  <name>Task 2: Manifest and traceability</name>
  <files>features/traceability.md, spec/traceability.md</files>
  <read_first>features/scripts/allocate-req-ea.py</read_first>
  <action>Run `python3 features/scripts/allocate-req-ea.py`; update `spec/traceability.md` §6's file-29 row to list REQ-EA-1522 and the new count; Document Control line (plan 31 ticket 15).</action>
  <verify><automated>python3 features/scripts/allocate-req-ea.py --check && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c "REQ-EA-1522" features/traceability.md` ≥ 1 (baseline 0).
  </acceptance_criteria>
  <done>Manifest and matrix current.</done>
</task>
</tasks>

<verification>
pnpm test:bdd && python3 features/scripts/allocate-req-ea.py --check && pnpm spec:verify:strict
</verification>

<success_criteria>
- REQ-EA-1522 scenario green and traced.
</success_criteria>

## Comments
