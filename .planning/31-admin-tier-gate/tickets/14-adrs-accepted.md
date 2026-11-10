---
plan: 31-admin-tier-gate
ticket: 14
title: "ADR-EA-050 Accepted, ADR-EA-018 revision 1.7, the actionDenied doc comment"
type: execute
wave: 4
depends_on: [05, 12]
files_modified:
  - spec/decisions/050-admin-tier-gate.md
  - spec/decisions/018-tenancy-is-an-organization.md
  - spec/decisions/index.yaml
  - packages/core/src/AuthEventSchemas.ts
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1522]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "ADR-EA-050 is Accepted — implemented and lists the implementing files and tests"
    - "ADR-EA-018 decision 8 names core's gate and SAML's per-operation gate fields"
    - "AdminActionDeniedEvent's doc comment says core's gate publishes it for admin, saml and webhooks"
  artifacts:
    - path: "spec/decisions/050-admin-tier-gate.md"
      contains: "Accepted — implemented"
  key_links:
    - from: "spec/decisions/018-tenancy-is-an-organization.md"
      to: "spec/decisions/050-admin-tier-gate.md"
      via: "decision 8 revision note (plan 31)"
      pattern: "ADR-EA-050"
---
Status: ready-for-agent
Blocked by: 05, 12

<objective>
Close the decision records once the code has landed.

Purpose: ADR-EA-050 moves from Proposed to Accepted with evidence; ADR-EA-018 D8 stops saying the gate is private to admin.
Output: two ADR revisions, the index status, one doc comment in core.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§6.2, §6.3)
@spec/decisions/050-admin-tier-gate.md (ticket 05)
@spec/decisions/018-tenancy-is-an-organization.md (decision 8 :48; revision notes :70-…)
@packages/core/src/AuthEventSchemas.ts (lines 389-400)
@.planning/README.md ("Revision numbers are assigned when a plan lands, in landing order")
</context>

<tasks>
<task type="auto">
  <name>Task 1: ADRs</name>
  <files>spec/decisions/050-admin-tier-gate.md, spec/decisions/018-tenancy-is-an-organization.md, spec/decisions/index.yaml</files>
  <read_first>spec/decisions/050-admin-tier-gate.md, spec/decisions/018-tenancy-is-an-organization.md</read_first>
  <action>ADR-EA-050: revision 1.1, Status "Accepted — implemented", change-history line, and fill "Implementation" with the files (`core/src/AdminTierGate.ts`, `admin/src/internal/AdminGate.ts`, `saml/src/SamlAdmin.ts`, `saml/src/Saml.ts`, `webhooks/src/Webhooks.ts`) and tests (`core/test/AdminTierGate*.test.ts`, the SAML by-id matrix, admin's `AdminGate*.test.ts`), and any deviation recorded in the tickets' Comments. If Q2 was "no", say admin declares a no-op throttle and why. ADR-EA-018: take the next free revision (1.7 unless another plan landed one first) and replace decision 8's admin sentence with PLAN §6.3's text; add a "Revision note (plan 31)" section explaining F1 and that SAML's `canManageSaml`/`adminRate` join the per-operation rule; change-history line. `index.yaml`: ADR-EA-050 status "Accepted — implemented".</action>
  <verify><automated>grep -c "Accepted — implemented" spec/decisions/050-admin-tier-gate.md && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c "ADR-EA-050" spec/decisions/018-tenancy-is-an-organization.md` ≥ 1 (baseline 0).
  </acceptance_criteria>
  <done>Both ADRs current.</done>
</task>

<task type="auto">
  <name>Task 2: The event's doc comment</name>
  <files>packages/core/src/AuthEventSchemas.ts</files>
  <read_first>packages/core/src/AuthEventSchemas.ts</read_first>
  <action>Rewrite the comment above `AdminActionDeniedEvent` (lines 390-400): published by `AdminTierGate` (ADR-EA-050, BEH-EA-347) for admin's predicates, `@awthaq/saml` (`saml.<action>`, naming `organizationId`) and `@awthaq/webhooks` (`webhooks.<action>`); `targetUserId`/`organizationId` are carried when the call named or read one. Comment only; no schema change.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/core && pnpm lint</automated></verify>
  <acceptance_criteria>
    - `grep -c "AdminTierGate" packages/core/src/AuthEventSchemas.ts` ≥ 1 (baseline 0).
    - `git diff --stat packages/core/src/AuthEventSchemas.ts` shows comment lines only.
  </acceptance_criteria>
  <done>The definition's doc matches the code.</done>
</task>
</tasks>

<verification>
pnpm spec:verify:strict && pnpm typecheck && pnpm lint && pnpm format:check
</verification>

<success_criteria>
- ADR-EA-050 Accepted; ADR-EA-018 amended; doc comment current.
</success_criteria>

## Comments
