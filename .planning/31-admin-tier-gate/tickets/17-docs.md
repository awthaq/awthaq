---
plan: 31-admin-tier-gate
ticket: 17
title: "READMEs and docs/plugin-authoring.md"
type: execute
wave: 4
depends_on: [12]
files_modified:
  - packages/admin/README.md
  - packages/saml/README.md
  - packages/webhooks/README.md
  - docs/plugin-authoring.md
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1522, REQ-EA-1523]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Each README describes its gate's predicate input (with tenantId), its per-operation reading and its throttle"
    - "docs/plugin-authoring.md tells a plugin author how to gate an admin-tier group with AdminTierGate, including when to use found"
  artifacts:
    - path: "docs/plugin-authoring.md"
      contains: "AdminTierGate"
  key_links:
    - from: "docs/plugin-authoring.md"
      to: "packages/core/src/AdminTierGate.ts"
      via: "a section naming named/found/ask and the declaration fields"
      pattern: "found"
---
Status: ready-for-agent
Blocked by: 12

<objective>
Document the declaration for hosts and plugin authors.

Purpose: hosts write the predicates; plugin authors must reach for `found` when a predicate needs the row.
Output: three README edits, one new section in `docs/plugin-authoring.md`.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.2–§3.4, §6.7)
@packages/admin/README.md, packages/saml/README.md, packages/webhooks/README.md (search canManage / actionDenied)
@docs/plugin-authoring.md
@scripts/check-readme-status.mjs
</context>

<tasks>
<task type="auto">
  <name>Task 1: READMEs</name>
  <files>packages/admin/README.md, packages/saml/README.md, packages/webhooks/README.md</files>
  <read_first>packages/saml/README.md</read_first>
  <action>SAML: `canManageSaml` receives `{ admin, action, organizationId, tenantId }`; by-id operations pass the connection's organization (BEH-EA-348), `organizationId` absent means "the action in general"; a refused connection answers like an absent one to an administrator who holds the action; a tenant's `Saml.config` governs `canManageSaml` and `adminRate`. Show the delegated predicate example `organizationId === undefined || organizationId === tenantOf(admin)` with one sentence on what each branch grants. Webhooks: `canManageWebhooks` receives `tenantId`. Admin: `canAdministerTenants` receives `tenantId`; if Q2 is yes, the three rules, their default and `RateLimits.overrides`. All three: the gate is `@awthaq/core`'s `AdminTierGate` (ADR-EA-050). Keep each README's status markers intact.</action>
  <verify><automated>pnpm check:readmes</automated></verify>
  <acceptance_criteria>
    - `grep -c "tenantId" packages/saml/README.md` ≥ 1 and `grep -c "tenantId" packages/webhooks/README.md` ≥ 1 (record the baselines before editing in Comments).
  </acceptance_criteria>
  <done>READMEs match the code.</done>
</task>

<task type="auto">
  <name>Task 2: Plugin authoring</name>
  <files>docs/plugin-authoring.md</files>
  <read_first>docs/plugin-authoring.md, packages/webhooks/src/Webhooks.ts</read_first>
  <action>Add a section "Gating an admin-tier group" after the configuration section: put the group behind `Api.AdminAuthentication`; yield `AdminTierGate.make({ config, built, prefix, predicate, names, denied, throttle })` once in the plugin's `make`; declare a `Key.user` rule in `rateLimitRules` and pass `limits.spend` as `throttle`; use `named` when the request names the target (or none) and `found` when the predicate can only judge the read row, never "ask, then read"; read configuration only from the clearance; never publish `auth.admin.actionDenied` yourself (core's boundary test fails). Point at `packages/webhooks/src/Webhooks.ts` (no target) and `packages/saml/src/SamlAdmin.ts` (`found`) as worked examples. The plugin template has no admin-tier group; say so in one line.</action>
  <verify><automated>grep -c "AdminTierGate" docs/plugin-authoring.md</automated></verify>
  <acceptance_criteria>
    - The grep prints ≥ 1 (baseline 0).
  </acceptance_criteria>
  <done>A plugin author can gate an admin-tier group without reading core's source.</done>
</task>
</tasks>

<verification>
pnpm check:readmes && pnpm format:check
</verification>

<success_criteria>
- READMEs and the authoring guide describe the declaration; README check passes.
</success_criteria>

## Comments
