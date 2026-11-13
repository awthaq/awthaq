---
plan: 36-config-scope
ticket: 19
title: "SCIM and the plugin template"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/scim/src/Scim.ts
  - examples/plugin-template/src/Template.ts
  - examples/plugin-template/test/Template.test.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1576, REQ-EA-1577]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "ScimConfig is declared Tenant.perDeployment and has a descriptor"
    - "The template's NotesConfig is declared Tenant.perTenant, read through Tenant.inForce, and has a descriptor"
    - "The template's existing per-request override test passes unchanged; a new case shows the descriptor's view under a calling override"
  artifacts:
    - path: "packages/scim/src/Scim.ts"
      provides: "ScimConfigScoped and its descriptor"
      contains: "Tenant.perDeployment(ScimConfig)"
    - path: "examples/plugin-template/src/Template.ts"
      provides: "the worked example a plugin author copies"
      contains: "Tenant.inForce(NotesConfigScoped)"
  key_links:
    - from: "Template make"
      to: "Tenant.inForce(NotesConfigScoped)"
      via: "settingsNow, yielded per operation"
      pattern: "settingsNow = yield\\* Tenant\\.inForce\\(NotesConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Declare `ScimConfig` per deployment with a descriptor, and turn the plugin template into the worked example of a per-tenant key.
Purpose: G1 for SCIM; G5 (a new plugin author copies the declaration, the accessor and the descriptor from the template, `docs/plugin-authoring.md`).
Output: two edited modules and one test.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows for SCIM and Notes, §3.2 worked case, §6.5)
@packages/scim/src/Scim.ts (lines 85-100, 518-528, 625-635, the plugin class)
@examples/plugin-template/src/Template.ts (lines 40-60, 395-415, the plugin class)
@examples/plugin-template/test/Template.test.ts (lines 30-90)
</context>

<tasks>
<task type="auto">
  <name>Task 1: SCIM</name>
  <files>packages/scim/src/Scim.ts</files>
  <read_first>Scim.ts:88-97, :520-526, :627-633</read_first>
  <action>Add `ScimConfigScoped = Tenant.perDeployment(ScimConfig)` next to `:90`; make `config` (`:95`) return its `layer`. Both reads are build reads: `const settings = yield* yield* Tenant.inForce(ScimConfigScoped)` at `:525` and the same for `cfg` at `:632`. Add `ConfigDescriptor.make(ScimConfigScoped)` to the SCIM plugin's `config:` list (add the list if absent); mark sensitive any secret field of `ScimConfigShape` (read it).</action>
  <verify><automated>npx vitest run packages/scim/test/ScimHttp.test.ts packages/scim/test/AuthComposition.test.ts packages/scim/test/ScimGroups.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *ScimConfig\b' packages/scim/src | wc -l` prints 0 (baseline 2)
    - `grep -c 'ConfigDescriptor.make(ScimConfigScoped' packages/scim/src/Scim.ts` prints 1 (baseline 0)
  </acceptance_criteria>
  <done>SCIM declared and visible.</done>
</task>

<task type="auto">
  <name>Task 2: the template as the worked example</name>
  <files>examples/plugin-template/src/Template.ts</files>
  <read_first>Template.ts:40-60, :405-412; PLAN.md §3.2's worked case</read_first>
  <action>Add `NotesConfigScoped = Tenant.perTenant(NotesConfig)` (no boot fields: `maxLength` and `maxNotesPerOwner` are read per operation) beside the reference, with a doc comment that says what a plugin author decides here (the scope, and any boot field) and cites ADR-EA-018 D8 and BEH-EA-362. Make `config` (`:54`) return its `layer`. Replace `:410` with `const settingsNow = yield* Tenant.inForce(NotesConfigScoped);` and update the comment above it to name the accessor. Add `ConfigDescriptor.make(NotesConfigScoped)` to the plugin's `config:` list (add the list if absent). Keep the template's comments teaching, short, and in the house vocabulary.</action>
  <verify><automated>pnpm build && npx vitest run examples/plugin-template/test/Template.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c 'Tenant.inForce(NotesConfigScoped)' examples/plugin-template/src/Template.ts` prints 1 (baseline 0)
    - `grep -c 'ConfigDescriptor.make(NotesConfigScoped' examples/plugin-template/src/Template.ts` prints 1 (baseline 0)
    - `grep -cE 'Layer\.succeed\(NotesConfig\b' examples/plugin-template/src/Template.ts` prints 0 (baseline 1)
  </acceptance_criteria>
  <done>The template shows the whole pattern.</done>
</task>

<task type="tdd">
  <name>Task 3: the template's view case</name>
  <files>examples/plugin-template/test/Template.test.ts</files>
  <read_first>Template.test.ts:68-90 (the per-request override case)</read_first>
  <behavior>
    - The existing case at `:68` passes unchanged.
    - New case: `EffectiveConfig.snapshot(built, [Notes descriptor])` run inside `Effect.provide(Template.config({ maxLength: 30 }))`, with `built` holding `Template.config({ maxLength: 20 })`, reports `maxLength` 30 with `scope: "tenant"` and `source: "tenant"`.
  </behavior>
  <action>Write the new case beside the existing one. It documents, in the place a plugin author reads, that the view and the operation agree.</action>
  <verify><automated>npx vitest run examples/plugin-template/test/Template.test.ts</automated></verify>
  <acceptance_criteria>
    - Both cases pass
  </acceptance_criteria>
  <done>The template proves G4 for a plugin-owned key.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
SCIM raw reads 2 → 0; template helper calls 1 → 0; descriptors +2; the template's view case passes.
</success_criteria>

## Comments

Result: ScimConfigScoped (perDeployment) + descriptor, 2 reads via inForce. Template: NotesConfigScoped = perTenant, settingsNow via Tenant.inForce, descriptor added, new view case (maxLength 30, tenant/tenant) passes.
