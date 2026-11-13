---
plan: 31-admin-tier-gate
ticket: 13
title: "Behaviours and traceability (BEH-EA-347, 349; 224, 236, 318, webhooks gate)"
type: execute
wave: 4
depends_on: [03, 04, 12]
files_modified:
  - spec/behaviors/27-admin-impersonation.md
  - spec/behaviors/28-tenancy.md
  - spec/behaviors/34-webhooks.md
  - spec/behaviors/29-saml-sp.md
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1521, REQ-EA-1522, REQ-EA-1523]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-347 states the gate's ordering, configuration read, denial naming and throttle for every admin-tier plugin"
    - "BEH-EA-349 states admin's rate rules (only if Q2 is yes)"
    - "BEH-EA-224, 236, 318 and the webhooks gate entry match the code"
  artifacts:
    - path: "spec/behaviors/27-admin-impersonation.md"
      contains: "## BEH-EA-347"
  key_links:
    - from: "spec/traceability.md"
      to: "packages/core/test/AdminTierGate.test.ts"
      via: "ADR-EA-050 row and §5 rows"
      pattern: "AdminTierGate"
---
Status: ready-for-agent
Blocked by: 03, 04, 12

<objective>
Make `spec/behaviors` and `spec/traceability.md` say what Track R made the code do.

Purpose: shared convention: every behaviour change updates its entry, its Document Control and the traceability matrix.
Output: two new behaviours, four edited entries, traceability rows.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.3, §6.1, §6.4)
@spec/behaviors/27-admin-impersonation.md (BEH-EA-221 :~340-400, BEH-EA-224 :~405-420; Document Control :7-12)
@spec/behaviors/28-tenancy.md (BEH-EA-236 :116-…)
@spec/behaviors/34-webhooks.md (the gate requirement at :148-155)
@spec/behaviors/29-saml-sp.md (BEH-EA-318, BEH-EA-348 from ticket 03)
@spec/traceability.md (ADR rows near :162; §5 admin rows :350-352)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Behaviour entries</name>
  <files>spec/behaviors/27-admin-impersonation.md, spec/behaviors/28-tenancy.md, spec/behaviors/34-webhooks.md, spec/behaviors/29-saml-sp.md</files>
  <read_first>spec/behaviors/27-admin-impersonation.md, spec/behaviors/34-webhooks.md</read_first>
  <action>In `27-admin-impersonation.md`: add `## BEH-EA-347: Every admin-tier operation passes one gate` (REQUIREMENT block): every operation of the `admin`, `admin.accounts`, `admin.tenants`, `saml.admin` and `webhooks.admin` groups MUST pass `@awthaq/core`'s `AdminTierGate`; it MUST read the plugin's configuration in force per operation, give the predicate the administrator, the action, the ambient `tenantId` and the target, refuse fail-closed by publishing exactly one `auth.admin.actionDenied` (action prefixed by the plugin, naming `targetUserId` or `organizationId` when the call named or read one) and answering the plugin's 403, spend the plugin's per-administrator rule only after a pass, and answer a target that must be read first per BEH-EA-348's rule; no plugin publishes `auth.admin.actionDenied` itself. If Q2 is yes, add `## BEH-EA-349: Each administrator is rate limited on the admin groups` (60 per minute per group by default, past the gate, tunable with `RateLimits.overrides`, refusals not counted, 429 `RateLimited`). Rewrite BEH-EA-224's sentence about SAML and webhooks: core's gate publishes for all three; SAML names `organizationId`. In BEH-EA-221, say the predicate pairing is admin's declaration and the ordering is BEH-EA-347's. In `28-tenancy.md` BEH-EA-236: the adopter list adds "saml's admin gate (`canManageSaml`, `adminRate`)" and the deployment-scoped list keeps the rest of saml. In `34-webhooks.md`: the `canManageWebhooks({ admin, action })` requirement gains `tenantId` and cites BEH-EA-347. In `29-saml-sp.md` BEH-EA-318: `canManageSaml({ admin, action, organizationId?, tenantId })` read per operation (a tenant's configuration governs it); cite BEH-EA-347. Bump each file's Document Control revision with a "(architecture plan 31)" change-history line, and add Previous/Next links for the new entries.</action>
  <verify><automated>grep -c "^## BEH-EA-347" spec/behaviors/27-admin-impersonation.md</automated></verify>
  <acceptance_criteria>
    - The grep prints 1 (baseline 0); `grep -c "^## BEH-EA-349"` prints 1 if Q2 is yes, else 0.
    - `grep -c "tenantId" spec/behaviors/34-webhooks.md` increases by at least 1.
  </acceptance_criteria>
  <done>The behaviours describe the gate.</done>
</task>

<task type="auto">
  <name>Task 2: Traceability</name>
  <files>spec/traceability.md</files>
  <read_first>spec/traceability.md</read_first>
  <action>Add an ADR-EA-050 row (title, BEH-EA-347–349, `packages/core/test/AdminTierGate.test.ts`, `.boundary.test.ts`, `.types.test.ts`, `packages/saml/test/SamlAdmin.test.ts`). §1: file 27 lists BEH-EA-347 (and 349). §5: rows for the three core test files; update the `AdminGate.test.ts` row (admin's declaration; the build-time fallback case moved to core), the `AdminGate.boundary.test.ts` row (no `configInForce`, no `actionDenied` in admin), the `packages/webhooks/test/*` row (the throttle wiring case) and the SAML row (per-tenant gate cases). Bump the Document Control revision with a plan-31 line.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c "ADR-EA-050" spec/traceability.md` ≥ 1 (baseline 0).
  </acceptance_criteria>
  <done>Spec verification passes.</done>
</task>
</tasks>

<verification>
pnpm spec:verify:strict && pnpm format:check
</verification>

<success_criteria>
- New behaviours present and traced; spec verification green.
</success_criteria>

## Comments
