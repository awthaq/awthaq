---
plan: 36-config-scope
ticket: 17
title: "SAML II: the remaining build reads"
type: execute
wave: 2
depends_on: ["16"]
files_modified:
  - packages/saml/src/Saml.ts
  - packages/saml/src/SamlConnections.ts
  - packages/saml/src/SamlSpKeys.ts
  - packages/saml/src/SamlMetadataFetcher.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1576]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Every SamlConfig read in the saml package goes through Tenant.inForce(SamlConfigScoped)"
    - "The SAML suites pass unchanged"
  artifacts:
    - path: "packages/saml/src/Saml.ts"
      provides: "four build reads through the accessor"
  key_links:
    - from: "Saml.ts, SamlConnections.ts, SamlSpKeys.ts, SamlMetadataFetcher.ts builds"
      to: "SamlConfig.SamlConfigScoped"
      via: "Tenant.inForce"
      pattern: "inForce\\(SamlConfig\\.SamlConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 16

<objective>
Route the seven remaining `SamlConfig` reads through the accessor.
Purpose: rule 2 (PLAN.md §3.5): a later scope change in the declaration (plan 31, or a future decision) moves every read with it.
Output: four edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§3.5)
@.planning/36-config-scope/tickets/16-saml-i.md (Comments: which branch was taken)
@packages/saml/src/Saml.ts (lines 438-446, 553-560, 763-770, 812-820)
@packages/saml/src/SamlConnections.ts (lines 212-220)
@packages/saml/src/SamlSpKeys.ts (lines 88-95)
@packages/saml/src/SamlMetadataFetcher.ts (lines 40-48)
</context>

<tasks>
<task type="auto">
  <name>Task 1: replace the seven reads</name>
  <files>packages/saml/src/Saml.ts, packages/saml/src/SamlConnections.ts, packages/saml/src/SamlSpKeys.ts, packages/saml/src/SamlMetadataFetcher.ts</files>
  <read_first>each read site in context</read_first>
  <action>Each site (`Saml.ts:443`, `:558`, `:768`, `:817`, `SamlConnections.ts:217`, `SamlSpKeys.ts:92`, `SamlMetadataFetcher.ts:45`) is a build read: replace `const settings = yield* SamlConfig.SamlConfig` with `const settings = yield* yield* Tenant.inForce(SamlConfig.SamlConfigScoped)`. If ticket 16 took the per-tenant branch, check each site: a build read used only for boot fields stays a build read; a site whose `settings` is captured by an operation and read for a non-boot field must instead bind `const settingsNow = yield* Tenant.inForce(SamlConfig.SamlConfigScoped)` and yield `settingsNow` in that operation. Record each site's verdict in Comments.</action>
  <verify><automated>npx vitest run packages/saml/test/Saml.test.ts packages/saml/test/SamlConnections.test.ts packages/saml/test/SamlKeys.test.ts packages/saml/test/SamlMetadataFetcher.test.ts packages/saml/test/SamlSignIn.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(SamlConfig\.SamlConfig|SsoConfig)\b' packages/saml/src | wc -l` prints 0 (baseline 10; 7 after ticket 16)
    - `grep -rn 'SamlConfig.SamlConfigScoped' packages/saml/src | wc -l` prints at least 9
  </acceptance_criteria>
  <done>SAML reads only through the accessor.</done>
</task>

<task type="auto">
  <name>Task 2: the HTTP and logout suites</name>
  <files>packages/saml/src/Saml.ts</files>
  <read_first>packages/saml/test/SamlHttp.test.ts, packages/saml/test/SamlSlo.test.ts (names only)</read_first>
  <action>No code change is expected. Run the wire and single-logout suites, which exercise `acsUrl` and `sloUrl` from the settings read in the build.</action>
  <verify><automated>pnpm build && npx vitest run packages/saml/test/SamlHttp.test.ts packages/saml/test/SamlSlo.test.ts packages/saml/test/SamlSloHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - All three suites pass unchanged
  </acceptance_criteria>
  <done>The SAML wire is unchanged.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
SAML raw reads 7 → 0; every SAML suite green.
</success_criteria>

## Comments

Result: all seven build reads (Saml.ts x4, SamlConnections, SamlSpKeys, SamlMetadataFetcher) replaced; per-deployment branch, so every site stays a build read. Raw SamlConfig/SsoConfig yields in packages/saml/src: 0. saml suites green.
