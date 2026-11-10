---
plan: 40-residue
ticket: 08
title: "Organization's authorized interface takes CurrentUser.Caller"
type: execute
wave: 3
depends_on: [01, 05]
files_modified:
  - packages/organization/src/OrganizationShape.ts
  - packages/organization/src/internal/access.ts
  - packages/organization/src/Organization.ts
  - packages/organization/src/OrganizationHandlers.ts
  - packages/organization/src/OrganizationActiveContext.ts
  - packages/organization/test/Organization.test.ts
  - packages/organization/test/OrganizationHooks.test.ts
  - packages/organization/test/OrganizationQadi.test.ts
  - packages/organization/test/OrganizationQadiPolicy.test.ts
  - packages/organization/test/OrganizationSql.test.ts
  - packages/organization/test/AuthorizationMatrix.test.ts
  - packages/organization/test/Access.types.test.ts
  - packages/saml/test/support.ts
  - packages/saml/test/SamlAdmin.test.ts
  - packages/saml/test/SamlConnections.test.ts
  - packages/scim/test/support.ts
  - .changeset/current-user-caller-organization.md
autonomous: true
requirements: [REQ-EA-1612]
estimate: {tasks: 3, size: L}
must_haves:
  truths:
    - "OrganizationShape's 40 methods take `caller: CurrentUser.Caller`"
    - "access.ts mints OrganizationActor.Actor.User from caller.userId/sessionId; callerId is gone"
    - "OrganizationHandlers passes `yield* CurrentUser.current`, not the wire principal"
    - "The authorization matrix and every organization test assertion are unchanged"
  artifacts:
    - path: packages/organization/src/internal/access.ts
      provides: "entry points over CurrentUser.Caller"
  key_links:
    - from: packages/organization/src/internal/access.ts
      to: packages/organization/src/OrganizationActor.ts
      via: "actorOf(caller) → ActorSchema.cases.User.make({ userId: caller.userId, sessionId: caller.sessionId })"
      pattern: "actorOf = \\(caller: CurrentUser\\.Caller\\)"
---
Status: ready-for-agent
Blocked by: 01, 05 (shares `packages/saml/test/SamlAdmin.test.ts`). Runs only if PLAN §10 Q3 = yes (default yes).

<objective>
Organization's authorized interface stops taking the wire principal.
Purpose: otherwise `CurrentUser.current` must keep handing out `principal` for `OrganizationHandlers.ts:32`, which is the bypass (PLAN §10 Q3). The `Actor` stays organization's (plan 04 Q7): it is minted *from* the caller.
Output: `caller: CurrentUser.Caller` in `OrganizationShape`, `internal/access.ts`, `Organization.ts`, `OrganizationActiveContext.sessionOf`; test helpers wrap their principal in `CurrentUser.of`.
Split rule waived (PLAN §4.3).
</objective>

<context>
@packages/organization/src/OrganizationShape.ts
@packages/organization/src/internal/access.ts (:88-320)
@packages/organization/src/Organization.ts (:165-375)
@packages/organization/src/OrganizationHandlers.ts (:25-40)
@packages/organization/src/OrganizationActiveContext.ts (:25-40)
@packages/organization/src/OrganizationActor.ts (Q7: Actor stays here)
@spec/decisions/040-plugin-exposes-domain-services.md decision 6 (the order access.ts writes; untouched)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: organization src</name>
    <files>packages/organization/src/OrganizationShape.ts, packages/organization/src/internal/access.ts, packages/organization/src/Organization.ts, packages/organization/src/OrganizationHandlers.ts, packages/organization/src/OrganizationActiveContext.ts</files>
    <read_first>the files in context</read_first>
    <action>OrganizationShape.ts: replace all 40 `caller: Api.UserPrincipal` with `caller: CurrentUser.Caller` (import `CurrentUser` from "@awthaq/core"). access.ts: replace the 17 parameter types; delete `callerId` and use `caller.userId` at its uses; `actorOf` builds `User.make({ userId: caller.userId, sessionId: caller.sessionId })` (the schema fields are strings; branded values are strings). Organization.ts :172, :333, :339, :372: `Users.UserId(caller.ref.id)` → `caller.userId`. OrganizationActiveContext.ts: `sessionOf(caller: CurrentUser.Caller)` returns `{ sessionId: caller.sessionId, userId: caller.userId }` (update every caller of `sessionOf`). OrganizationHandlers.ts:29-32: the handler-side caller becomes `CurrentUser.current` itself; update the GC-003 doc comment to say the authorized interface takes `CurrentUser.Caller`, and keep whatever `Api` import declaration emit needs (TS2883 comment). Do not change the order or content of any access check (ADR-EA-040 decision 6).</action>
    <verify><automated>rg -n 'caller: Api\.UserPrincipal|caller\.ref\.id|principal\.ref\.id' packages/organization/src | wc -l   # baseline 63 lines at HEAD, expect 0</automated></verify>
    <done>Organization src free of the wire caller.</done>
  </task>
  <task type="auto">
    <name>Task 2: organization test helpers</name>
    <files>packages/organization/test/Organization.test.ts, packages/organization/test/OrganizationHooks.test.ts, packages/organization/test/OrganizationQadi.test.ts, packages/organization/test/OrganizationQadiPolicy.test.ts, packages/organization/test/OrganizationSql.test.ts, packages/organization/test/AuthorizationMatrix.test.ts, packages/organization/test/Access.types.test.ts</files>
    <read_first>each file's `asCaller` (Organization.test.ts:33, OrganizationHooks.test.ts:47, OrganizationQadi.test.ts:46, OrganizationQadiPolicy.test.ts:47, OrganizationSql.test.ts:30, AuthorizationMatrix.test.ts:58 and :137, Access.types.test.ts:37-82)</read_first>
    <action>Each helper returns `CurrentUser.of(new Api.UserPrincipal({...}))`, typed `CurrentUser.Caller`; parameter annotations `caller: Api.UserPrincipal` in AuthorizationMatrix.test.ts and Access.types.test.ts become `CurrentUser.Caller`. Change no assertion and no `@ts-expect-error` expectation in Access.types.test.ts (if one stops erroring, stop and report: it means the proof brand weakened).</action>
    <verify><automated>npx vitest run packages/organization/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>`git diff -U0 packages/organization/test | grep -c '^[-+].*(assert|ts-expect-error)'` = 0 (use grep -E).</acceptance_criteria>
    <done>Organization suite and authorization matrix green.</done>
  </task>
  <task type="auto">
    <name>Task 3: dependents' test helpers and changeset</name>
    <files>packages/saml/test/support.ts, packages/saml/test/SamlAdmin.test.ts, packages/saml/test/SamlConnections.test.ts, packages/scim/test/support.ts, .changeset/current-user-caller-organization.md</files>
    <read_first>saml/test/support.ts:100-140; SamlConnections.test.ts:35-45; SamlAdmin.test.ts:20-55; scim/test/support.ts:55-80</read_first>
    <action>`ownerPrincipal` (saml support.ts:104), `owner` (SamlConnections.test.ts:39) and scim's `ownerPrincipal(id)` (:61) are passed to `organization.create`; wrap each in `CurrentUser.of(...)` (keeping their names). Changeset `"@awthaq/organization": minor`, `Migration: Organization's authorized methods take CurrentUser.Caller; OrganizationActiveContext.sessionOf takes a Caller.`</action>
    <verify><automated>npx vitest run packages/saml/test packages/scim/test && pnpm typecheck</automated></verify>
    <done>SAML and SCIM suites green.</done>
  </task>
</tasks>

<threat_model>
## Trust edges
| Edge | Description |
|---|---|
| member caller → `OrganizationAccess` | the caller id decides membership (MTI-009) and the ceiling a role-conferring call may confer |

## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-10 | Elevation of privilege | access proof minting | high | mitigate | only the parameter type changes; the order (ADR-EA-040 decision 6) and the generated authorization matrix (`AuthorizationMatrix.test.ts`) are unchanged and green |
| T-40-11 | Information disclosure | organization existence probe (BEH-EA-284) | medium | mitigate | covered by the unchanged matrix and AuthHttp probes |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>A2/A3 gates for organization = 0 (baselines 6 / 57); authorization matrix green; no assertion changed in any of the 11 test files.</success_criteria>

## Comments
