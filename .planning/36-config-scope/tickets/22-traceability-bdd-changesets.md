---
plan: 36-config-scope
ticket: 22
title: "Traceability, BDD scenarios and the changeset"
type: execute
wave: 3
depends_on: ["21", "14"]
files_modified:
  - spec/traceability.md
  - features/features/12-multi-tenancy/28-tenancy.feature
  - features/step-definitions/TenancySteps.ts
  - features/step-definitions/TenancyWorld.ts
  - .changeset/config-scope.md
autonomous: true
requirements: [REQ-EA-1570, REQ-EA-1571]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "REQ-EA-1570: under acme, the effective configuration lists Password minLength 40, scope tenant, source tenant"
    - "REQ-EA-1571: with no tenant, the same read lists the build value with source default or override"
    - "REQ-EA-1307 and REQ-EA-1308 still pass"
    - "spec/traceability.md maps BEH-EA-362 and BEH-EA-363 to their tests and lists REQ-EA-1570..1571"
    - "One changeset with a Migration line covers every touched package"
  artifacts:
    - path: ".changeset/config-scope.md"
      provides: "the release note and Migration line of PLAN.md §6.6"
      contains: "Migration:"
    - path: "features/features/12-multi-tenancy/28-tenancy.feature"
      provides: "REQ-EA-1570, REQ-EA-1571"
      contains: "@REQ-EA-1570"
  key_links:
    - from: "the scenarios"
      to: "Admin.effectiveConfig under the AdminAccountsTenantConfig world"
      via: "TenancySteps"
      pattern: "effectiveConfig"
---
Status: done (uncommitted)
Blocked by: 21, 14

<objective>
Close the plan's paper trail: traceability rows, two BDD scenarios for the view, and the changeset.
Purpose: the repo's per-behaviour rule (spec, traceability, BDD, changeset with `Migration:`).
Output: one spec file, one feature, two step-definition files, one changeset.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§6.4, §6.6)
@spec/traceability.md (Document Control; the ADR-EA-018 and ADR-EA-006 rows; the §6 row for file 12 at line 435)
@features/features/12-multi-tenancy/28-tenancy.feature (lines 331-379, the `@BEH-EA-236` rule)
@features/step-definitions/TenancyWorld.ts (lines 205-247, the admin-accounts stack)
@features/step-definitions/TenancySteps.ts (the REQ-EA-1307/1308 steps)
@packages/admin/src/Admin.ts (`effectiveConfig`'s signature, after ticket 14)
@.changeset/admin-accounts-tenant-config.md (the house changeset shape)
</context>

<tasks>
<task type="auto">
  <name>Task 1: scenarios and steps</name>
  <files>features/features/12-multi-tenancy/28-tenancy.feature, features/step-definitions/TenancySteps.ts, features/step-definitions/TenancyWorld.ts</files>
  <read_first>the feature's `@BEH-EA-236` rule; TenancyWorld.ts:205-247; the existing 1307/1308 steps</read_first>
  <action>Under the `@BEH-EA-236` rule add two scenarios tagged `@BEH-EA-363` with PLAN.md §6.4's titles and ids (`@REQ-EA-1570`, `@REQ-EA-1571`). In TenancyWorld: acme's `Admin.config` in `AdminAccountsTenantConfig` (`:220`) and the build-time `Admin.config` (`:239`) each gain `canManageUsers: () => Effect.succeed(true)` (the view's gate), and `AdminAccountsServices` gains `Admin.Admin` so a step can call `effectiveConfig`. Write the steps in TenancySteps, reusing the 1307/1308 steps' way of running an operation in a request naming acme (and with no tenant); assert the Password item's `minLength` entry, `scope` and `source`. Keep the existing scenarios' wording and steps unchanged.</action>
  <verify><automated>pnpm build && pnpm --filter @awthaq/features exec vitest run features/12-multi-tenancy/28-tenancy.steps.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -cE '@REQ-EA-157[01]' features/features/12-multi-tenancy/28-tenancy.feature` prints 2 (baseline 0)
    - The tenancy feature passes, REQ-EA-1307 and REQ-EA-1308 included
  </acceptance_criteria>
  <done>The view's per-tenant behaviour is a living scenario.</done>
</task>

<task type="auto">
  <name>Task 2: traceability</name>
  <files>spec/traceability.md</files>
  <read_first>spec/traceability.md Document Control and the rows named in context</read_first>
  <action>Add rows for BEH-EA-362 (tests: `packages/ports/test/TenantConfigScope.test.ts`, `packages/organization/test/TenantConfigScope.types.test.ts`, `packages/saml/test/SamlTenantScope.types.test.ts`, `packages/core/test/ConfigScope.guard.test.ts`, ticket 02's pins in `packages/magic-link/test/MagicLink.test.ts`, `packages/magic-link/test/EmailOtp.test.ts`, `packages/webhooks/test/WebhooksTenant.test.ts`) and BEH-EA-363 (`packages/core/test/EffectiveConfig.test.ts`, `packages/admin/test/AdminConfig.test.ts`, `examples/plugin-template/test/Template.test.ts`, the two scenarios). Add both to the ADR-EA-018 and ADR-EA-006 rows. In the §6 row for file 12 (`:435`) add REQ-EA-1570–1571 and update its counts. Revision 1.77 → 1.78 with a change-history row naming plan 36. Do not add REQ-EA-1572..1577 anywhere (plan labels only).</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -cE 'BEH-EA-36[23]' spec/traceability.md` prints at least 4 (baseline 0)
    - `grep -cE 'REQ-EA-157[2-7]' spec/traceability.md features/features/12-multi-tenancy/28-tenancy.feature` prints 0 for both files
    - `pnpm spec:verify:strict` passes
  </acceptance_criteria>
  <done>Every new behaviour is traced.</done>
</task>

<task type="auto">
  <name>Task 3: the changeset</name>
  <files>.changeset/config-scope.md</files>
  <read_first>.changeset/admin-accounts-tenant-config.md; `git diff --stat 04fa3526 -- packages examples` (the touched packages)</read_first>
  <action>Write one changeset: `minor` for `@awthaq/ports`, `@awthaq/core` and `@awthaq/admin`, `patch` for every other package with a source change in this plan (derive the list from the diff stat; the template under `examples/` is not published, leave it out unless it has a `package.json` name in the changeset config). Body: one paragraph on what changed for an operator (`GET /admin/config` under a tenant shows that tenant's values, with `scope` and `source`), one for plugin authors (the declaration and the accessor), then PLAN.md §6.6's Migration line verbatim.</action>
  <verify><automated>pnpm changeset status</automated></verify>
  <acceptance_criteria>
    - `grep -c '^Migration:' .changeset/config-scope.md` prints 1
    - `grep -c '"@awthaq/ports": minor' .changeset/config-scope.md` prints 1
    - `pnpm changeset status` lists every package the diff stat touched
  </acceptance_criteria>
  <done>The release notes say what moves and how to migrate.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
pnpm check
</verification>

<success_criteria>
Two scenarios green; traceability 1.78 with BEH-EA-362/363; one changeset; `pnpm check` passes on the branch (the plan's gate).
</success_criteria>

## Comments

Result (uncommitted): REQ ids are REQ-EA-1563 (tenant view) and REQ-EA-1564 (no tenant), tagged @BEH-EA-356, added to 28-tenancy.feature with steps in TenancySteps.ts and TenancyWorld.ts (the admin-accounts stack gains `Admin.Admin`, `canManageUsers` and `EffectiveConfig.layer(manifest)`). Tenancy feature: 60 passed, 7 skipped (REQ-EA-1307/1308 included). features/traceability.md regenerated with allocate-req-ea.py. spec/traceability.md revision 1.82, spec/README.md 1.20. Changeset .changeset/config-scope.md (ports, core, admin minor; others patch, including sql and server; two-factor, roles, qadi omitted because ticket 18 is not done). `pnpm spec:verify:strict`: 32 pass, 0 fail. `pnpm changeset status` and `pnpm check` not run (parent).
