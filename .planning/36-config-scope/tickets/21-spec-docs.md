---
plan: 36-config-scope
ticket: 21
title: "Spec, ADR amendments and plugin-authoring docs"
type: execute
wave: 3
depends_on: ["20"]
files_modified:
  - spec/behaviors/28-tenancy.md
  - spec/behaviors/26-cli.md
  - spec/decisions/018-tenancy-is-an-organization.md
  - spec/decisions/006-runtime-config-separate-from-installation.md
  - docs/plugin-authoring.md
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574, REQ-EA-1577]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "BEH-EA-362 exists in 28-tenancy.md and BEH-EA-363 in 26-cli.md, with PLAN.md §6.3's requirement text"
    - "BEH-EA-236 no longer enumerates the per-tenant keys or names the old helper; it points to BEH-EA-362"
    - "ADR-EA-018 decision 8 is revision 1.7 and ADR-EA-006 revision 1.4, each with a change-history row naming plan 36"
    - "docs/plugin-authoring.md teaches the declaration, the accessor, boot fields and the refusal"
  artifacts:
    - path: "spec/behaviors/28-tenancy.md"
      provides: "BEH-EA-362; revision 1.13"
      contains: "BEH-EA-362"
    - path: "spec/behaviors/26-cli.md"
      provides: "BEH-EA-363; revision 1.7"
      contains: "BEH-EA-363"
  key_links:
    - from: "BEH-EA-236"
      to: "BEH-EA-362"
      via: "a link replacing the enumeration"
      pattern: "beh-ea-362"
---
Status: done (uncommitted)
Blocked by: 20; Q4 (PLAN.md §10) answered or at its default (amend, no ADR-EA-055)

<!-- planner-discipline-allow: configInForce -->

<objective>
Write the behaviour, ADR and docs changes of PLAN.md §6.1-§6.5.
Purpose: every behaviour change updates its spec entry, and the plugin author's guide matches the code.
Output: two behaviour files, two ADRs, one doc.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§6.1, §6.2, §6.3, §6.5, Q4)
@spec/behaviors/28-tenancy.md (Document Control lines 1-14; BEH-EA-236 at lines 120-130; BEH-EA-237 at 132)
@spec/behaviors/26-cli.md (Document Control; BEH-EA-229)
@spec/decisions/018-tenancy-is-an-organization.md (Document Control; decision 8 at line 48)
@spec/decisions/006-runtime-config-separate-from-installation.md (Document Control; the revision 1.2 paragraph)
@docs/plugin-authoring.md (lines 14, 155-160, 284)
@spec/glossary.md
</context>

<tasks>
<task type="auto">
  <name>Task 1: behaviours</name>
  <files>spec/behaviors/28-tenancy.md, spec/behaviors/26-cli.md</files>
  <read_first>an existing entry's shape in each file (heading, REQUIREMENT block, Implementation note, Previous/Next footer)</read_first>
  <action>In `28-tenancy.md` add BEH-EA-362 after BEH-EA-237 with PLAN.md §6.3's REQUIREMENT text, an Implementation note naming `Tenant.perTenant`, `Tenant.perDeployment`, `Tenant.inForce`, `Tenant.resolveConfig` and `Tenant.DeploymentConfigApplied` (ports `Tenant.ts`), the 10 per-tenant keys of PLAN.md §2.3 with their boot fields as recorded in tickets 05-14's Comments, and the tests of PLAN.md §6.4; fix the Previous/Next footers of BEH-EA-237 and the new entry. Reword BEH-EA-236's paragraph at `:128`: drop the enumeration and the old helper's name, and link BEH-EA-362. Revision 1.12 → 1.13 with a change-history row "1.13 (date): BEH-EA-362: each configuration key declares its scope and one accessor resolves it; BEH-EA-236 points to it (plan 36)". In `26-cli.md` add BEH-EA-363 after BEH-EA-229 with §6.3's text, and amend BEH-EA-229's Implementation note per §6.3's fourth bullet; revision 1.6 → 1.7 with a row naming plan 36. Use only the house vocabulary.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c '## BEH-EA-362' spec/behaviors/28-tenancy.md` prints 1 and `grep -c '## BEH-EA-363' spec/behaviors/26-cli.md` prints 1 (baselines 0)
    - `grep -c 'configInForce' spec/behaviors/28-tenancy.md` prints 0 (baseline: measure at the start; at least 1, at `:128`)
    - `pnpm spec:verify:strict` passes, or fails only on the traceability rows ticket 22 adds (record which in Comments)
  </acceptance_criteria>
  <done>Two new behaviours, two reworded.</done>
</task>

<task type="auto">
  <name>Task 2: ADR amendments</name>
  <files>spec/decisions/018-tenancy-is-an-organization.md, spec/decisions/006-runtime-config-separate-from-installation.md</files>
  <read_first>each ADR's decision text and Document Control</read_first>
  <action>ADR-EA-018: in decision 8 (`:48`) replace the sentence naming the old helper and its adopter enumeration with PLAN.md §6.1's revision 1.7 paragraph, verbatim except for line wrapping; revision 1.6 → 1.7 with §6.1's change-history row. ADR-EA-006: add §6.2's sentence to the revision 1.2 paragraph; revision 1.3 → 1.4 with a row naming plan 36. Do not change either ADR's status or any other decision. If Q4 was answered "new ADR", instead write `spec/decisions/055-configuration-scope-is-declared-with-the-key.md` with §6.1's text as its decision and make ADR-EA-018 rev 1.7 link to it (add that file to this ticket's files and record it in Comments).</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c 'configInForce' spec/decisions/018-tenancy-is-an-organization.md` prints 0 (baseline at least 1)
    - `grep -c 'Tenant.inForce' spec/decisions/018-tenancy-is-an-organization.md` prints at least 1 (baseline 0)
  </acceptance_criteria>
  <done>The ADRs describe the mechanism the code has.</done>
</task>

<task type="auto">
  <name>Task 3: plugin-authoring docs</name>
  <files>docs/plugin-authoring.md</files>
  <read_first>docs/plugin-authoring.md lines 10-20, 150-165, 280-290; examples/plugin-template/src/Template.ts after ticket 19</read_first>
  <action>Update the Config row (`:14`): a `Context.Reference` with a default, a scope declaration (`Tenant.perTenant` or `Tenant.perDeployment`), a `config(partial)` built from the declaration's `layer`, and a descriptor made from the declaration. Rewrite "Per-tenant configuration" (`:155-160`): declare the scope next to the reference; read through `Tenant.inForce` (yield once in the build, yield the result per operation); declare as boot only a field no operation reads per request, never a `can*` predicate; a per-deployment `config(...)` cannot go in a `TenantConfig` lookup (a type error), and a raw `Layer.succeed(Key, ...)` in a lookup bypasses that check, so use `config(...)`. Point to the template's lines by name, not number. Checklist item 3 (`:284`) becomes "Config as a `Context.Reference` with a default and its scope declaration".</action>
  <verify><automated>pnpm check:readmes && npx vitest run examples/plugin-template/test/Template.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c 'configInForce' docs/plugin-authoring.md` prints 0 (baseline 1)
    - `grep -c 'Tenant.inForce' docs/plugin-authoring.md` prints at least 1 (baseline 0)
  </acceptance_criteria>
  <done>The guide and the template agree.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
pnpm spec:verify:strict
</verification>

<success_criteria>
BEH-EA-362/363 added; BEH-EA-236/229 reworded; ADR-EA-018 1.7, ADR-EA-006 1.4; old helper name 0 in spec and docs.
</success_criteria>

## Comments

Result (uncommitted): ids renumbered to BEH-EA-355 (28-tenancy.md, appended after BEH-EA-328 so the 237->238 footer chain is untouched; revision 1.13) and BEH-EA-356 (26-cli.md, revision 1.8 because 1.7 was already taken); every BEH-EA-362/363 in code and tests rewritten to 355/356. BEH-EA-236 points to 355, which lists the 10 per-tenant keys with boot fields (from tickets 05-17). BEH-EA-229 Implementation amended. ADR-EA-018 rev 1.7 and ADR-EA-006 rev 1.4 (Q4 default: no new ADR). `configInForce` removed from spec/docs (traceability row reworded to Tenant.inForce). docs/plugin-authoring.md updated. Two-factor and roles documented as deployment-scoped intent, declaration deferred to ticket 18 follow-up; ConfigDescriptor.make's transitional bare-Reference overload noted. `pnpm spec:verify:strict` passes.
