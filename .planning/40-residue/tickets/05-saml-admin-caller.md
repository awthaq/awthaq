---
plan: 40-residue
ticket: 05
title: "SAML admin operations take CurrentUser.Caller"
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/saml/src/SamlAdmin.ts
  - packages/saml/src/Saml.ts
  - packages/saml/test/SamlAdmin.test.ts
  - .changeset/current-user-caller-saml.md
autonomous: true
requirements: [REQ-EA-1611]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Every SamlAdminShape operation takes `caller: CurrentUser.Caller`"
    - "canManageSaml, the auth.admin.actionDenied event and the throttle key see the same user id as before"
  artifacts:
    - path: packages/saml/src/SamlAdmin.ts
      provides: "SamlAdminShape over CurrentUser.Caller"
  key_links:
    - from: packages/saml/src/Saml.ts
      to: packages/saml/src/SamlAdmin.ts
      via: "saml.admin handlers pass `yield* CurrentUser.current`"
      pattern: "admin\\.\\w+\\(\\s*yield\\* CurrentUser\\.current"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
The SAML admin interface stops taking the wire principal.
Purpose: 10 `caller: Api.UserPrincipal` parameters and 4 `caller.ref.id` reads in `SamlAdmin.ts` (PLAN §2.A.3).
Output: `caller: CurrentUser.Caller`; `adminId` deleted; the `saml.admin` handlers in `Saml.ts` pass the caller.
</objective>

<context>
@packages/saml/src/SamlAdmin.ts (shape :30-95, authorize :134-153, adminId :155)
@packages/saml/src/Saml.ts (saml.admin handlers :595-675; leave `logout` :176-179 and :562 to ticket 06)
@packages/saml/test/SamlAdmin.test.ts (:37 admin, :181 other)
@.planning/40-residue/PLAN.md §8 (plan 31)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: SamlAdmin and its handlers</name>
    <files>packages/saml/src/SamlAdmin.ts, packages/saml/src/Saml.ts</files>
    <read_first>packages/saml/src/SamlAdmin.ts:1-200; packages/saml/src/Saml.ts:590-680</read_first>
    <precondition>No unmerged plan-31 branch edits these files (`git branch -a --list '*admin-tier-gate*'` prints nothing, or only merged branches). Otherwise halt and report.</precondition>
    <action>In SamlAdmin.ts replace every `caller: Api.UserPrincipal` (10) with `caller: CurrentUser.Caller` (import `CurrentUser` from "@awthaq/core"). In `authorize` use `caller.userId` for `makeSubject({ id })`, the denial event's `adminUserId` (no re-brand) and `throttle(caller.userId, action)`. Delete `adminId` (:155) and use `caller.userId` at its call sites. In Saml.ts, in the `saml.admin` group handlers (:599-670, 8 sites) replace `(yield* CurrentUser.current).principal` with `yield* CurrentUser.current`. Do not touch `logout` (ticket 06).</action>
    <verify><automated>pnpm typecheck 2>&1 | grep -c 'packages/saml/src/SamlAdmin'   # expect 0</automated></verify>
    <acceptance_criteria>`rg -n 'Api\.UserPrincipal|caller\.ref\.id' packages/saml/src/SamlAdmin.ts` prints nothing (baseline 10 + 4); `rg -c 'CurrentUser\.current\)\.principal' packages/saml/src/Saml.ts` prints nothing (baseline 8).</acceptance_criteria>
    <done>SAML src compiles.</done>
  </task>
  <task type="auto">
    <name>Task 2: test caller and changeset</name>
    <files>packages/saml/test/SamlAdmin.test.ts, .changeset/current-user-caller-saml.md</files>
    <read_first>packages/saml/test/SamlAdmin.test.ts:30-60, :175-190</read_first>
    <action>Wrap the two principals passed to `ops.*` (`admin` :37, `other` :181) with `CurrentUser.of(...)`. Leave `ownerPrincipal` (support.ts) alone: it is passed to `organization.create`, which ticket 08 converts. Changeset `.changeset/current-user-caller-saml.md`: `"@awthaq/saml": minor`, `Migration: SamlAdmin operations take CurrentUser.Caller.`</action>
    <verify><automated>npx vitest run packages/saml/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>No assertion line changed in packages/saml/test (`git diff -U0 packages/saml/test | grep -c '^[-+].*assert'` = 0).</acceptance_criteria>
    <done>SAML suite green.</done>
  </task>
</tasks>

<threat_model>
## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-05 | Elevation of privilege | `canManageSaml` subject | medium | mitigate | the subject id is the same user id; `SamlAdmin.test.ts` denial cases (:89-95, :181) unchanged and green |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>SamlAdmin.ts free of the wire principal; SAML suite green with no assertion changed.</success_criteria>

## Comments

Result: SamlAdminShape (10 ops) and Saml.logout/SamlSlo.logout take CurrentUser.Caller; adminId and the sessionId re-brand deleted; handlers pass `yield* CurrentUser.current`. Saml tests 353 green, no assertion changed. Test helper shapes: SamlAdmin.test.ts `admin`/`other` = CurrentUser.of(new Api.UserPrincipal(...)); SamlSlo.test.ts `principalOf(userId, sessionId)` returns a Caller; support.ts `ownerPrincipal` and SamlConnections.test.ts `owner` remain raw UserPrincipal (for organization.create, ticket 08). Changeset: .changeset/current-user-caller-saml.md (05), current-user-caller-saml-logout.md (06). Open: features/step-definitions/SamlFederationSteps.ts (outside my scope) passes UserPrincipal to admin/logout at ~16 sites and fails tsc.
