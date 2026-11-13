---
plan: 40-residue
ticket: 06
title: "Saml.logout takes CurrentUser.Caller"
type: execute
wave: 3
depends_on: [05]
files_modified:
  - packages/saml/src/Saml.ts
  - packages/saml/src/SamlSlo.ts
  - packages/saml/test/SamlSlo.test.ts
  - .changeset/current-user-caller-saml-logout.md
autonomous: true
requirements: [REQ-EA-1611]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Saml.logout and SamlSlo's logout take CurrentUser.Caller and re-brand no session id"
    - "BEH-EA-315 (SP-initiated logout) tests unchanged and green"
  artifacts:
    - path: packages/saml/src/SamlSlo.ts
      provides: "logout over caller.sessionId (already Sessions.SessionId)"
  key_links:
    - from: packages/saml/src/Saml.ts
      to: packages/saml/src/SamlSlo.ts
      via: "the saml.account logout handler passes `yield* CurrentUser.current`"
      pattern: "saml\\.logout\\(yield\\* CurrentUser\\.current"
---
Status: done (uncommitted)
Blocked by: 05

<objective>
The user's own SAML logout stops taking the wire principal.
Purpose: `Saml.ts:176-179` and `SamlSlo.ts:178-184` take `Api.UserPrincipal` only to re-brand `sessionId` (PLAN §2.A.3).
Output: `logout(caller: CurrentUser.Caller, input)`.
</objective>

<context>
@packages/saml/src/Saml.ts (:170-180 shape, :555-575 handler)
@packages/saml/src/SamlSlo.ts (:176-200)
@packages/saml/test/SamlSlo.test.ts (:50)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: logout signature</name>
    <files>packages/saml/src/Saml.ts, packages/saml/src/SamlSlo.ts</files>
    <read_first>packages/saml/src/SamlSlo.ts:170-215; packages/saml/src/Saml.ts:170-180, :555-575</read_first>
    <action>Change `logout`'s first parameter to `caller: CurrentUser.Caller` in `SamlShape` (Saml.ts :176-179) and in SamlSlo.ts (:178-181); in SamlSlo replace `const sessionId = Sessions.SessionId(caller.sessionId)` with `const sessionId = caller.sessionId`. In the `saml.account` logout handler (:562-563) pass `yield* CurrentUser.current` instead of destructuring `principal`. Remove `Api` imports only where nothing else uses them.</action>
    <verify><automated>pnpm typecheck 2>&1 | grep -c 'packages/saml/src'   # expect 0</automated></verify>
    <acceptance_criteria>`rg -n 'Api\.UserPrincipal' packages/saml/src` prints nothing (baseline at HEAD 12; after ticket 05: 2); `rg -n 'Sessions\.SessionId\(caller' packages/saml/src` prints nothing (baseline 1).</acceptance_criteria>
    <done>SAML src free of the wire principal.</done>
  </task>
  <task type="auto">
    <name>Task 2: test and changeset</name>
    <files>packages/saml/test/SamlSlo.test.ts, .changeset/current-user-caller-saml-logout.md</files>
    <read_first>packages/saml/test/SamlSlo.test.ts:40-60</read_first>
    <action>The helper at :50 returns `CurrentUser.of(new Api.UserPrincipal({...}))`; no assertion changes. Changeset `"@awthaq/saml": minor`, `Migration: Saml.logout takes CurrentUser.Caller.`</action>
    <verify><automated>npx vitest run packages/saml/test/SamlSlo.test.ts && pnpm typecheck</automated></verify>
    <done>SLO suite green.</done>
  </task>
</tasks>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>No `Api.UserPrincipal` in saml src; SLO tests green unchanged.</success_criteria>

## Comments

Result: SamlAdminShape (10 ops) and Saml.logout/SamlSlo.logout take CurrentUser.Caller; adminId and the sessionId re-brand deleted; handlers pass `yield* CurrentUser.current`. Saml tests 353 green, no assertion changed. Test helper shapes: SamlAdmin.test.ts `admin`/`other` = CurrentUser.of(new Api.UserPrincipal(...)); SamlSlo.test.ts `principalOf(userId, sessionId)` returns a Caller; support.ts `ownerPrincipal` and SamlConnections.test.ts `owner` remain raw UserPrincipal (for organization.create, ticket 08). Changeset: .changeset/current-user-caller-saml.md (05), current-user-caller-saml-logout.md (06). Open: features/step-definitions/SamlFederationSteps.ts (outside my scope) passes UserPrincipal to admin/logout at ~16 sites and fails tsc.
