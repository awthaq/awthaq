---
plan: 40-residue
ticket: 04
title: "Webhooks admin operations take CurrentUser.Caller"
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/webhooks/src/Webhooks.ts
  - packages/webhooks/test/support.ts
  - packages/webhooks/test/WebhooksAdmin.test.ts
  - .changeset/current-user-caller-webhooks.md
autonomous: true
requirements: [REQ-EA-1611]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Every webhooks admin operation takes `caller: CurrentUser.Caller`"
    - "The webhooks admin gate, its denial event (auth.admin.actionDenied with adminUserId) and its rate-limit key are unchanged in value"
  artifacts:
    - path: packages/webhooks/src/Webhooks.ts
      provides: "WebhooksShape admin methods over CurrentUser.Caller"
  key_links:
    - from: packages/webhooks/src/Webhooks.ts
      to: packages/core/src/CurrentUser.ts
      via: "handlers pass `yield* CurrentUser.current`; authorize reads caller.userId"
      pattern: "caller: CurrentUser\\.Caller"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
The webhooks admin interface stops taking the wire principal.
Purpose: 11 `caller: Api.UserPrincipal` parameters and 5 `caller.ref.id` reads (PLAN §2.A.3).
Output: `caller: CurrentUser.Caller` throughout; `adminId` helper deleted.
</objective>

<context>
@packages/webhooks/src/Webhooks.ts (shape :65-140, handlers :415-500, authorize :526-542, adminId :559, createdBy :633)
@packages/webhooks/test/support.ts (:176-180 adminPrincipal)
@packages/core/src/CurrentUser.ts (after ticket 01)
@.planning/40-residue/PLAN.md §2.A.3, §8 (plan 31)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: shape, handlers, authorize</name>
    <files>packages/webhooks/src/Webhooks.ts</files>
    <read_first>packages/webhooks/src/Webhooks.ts lines 60-140, 415-640</read_first>
    <precondition>No unmerged plan-31 branch edits this file: `git branch -a --list '*admin-tier-gate*'` prints nothing, or every branch it prints is merged into the current branch (`git branch --merged`). Otherwise halt and report (PLAN §8: the second to land rebases).</precondition>
    <action>Replace every `caller: Api.UserPrincipal` (11) with `caller: CurrentUser.Caller` (shape and implementation, including `authorize`). In `authorize` read `caller.userId` for `makeSubject({ id: ... })`, the `adminUserId` of the denial event (no re-brand: it is already `Users.UserId`) and the rate-limit key `{ userId: caller.userId }`. Delete `adminId` (:559) and replace its uses with `caller.userId`; `createdBy: caller.userId` (:633). In the handlers (:421-498) replace `(yield* CurrentUser.current).principal` with `yield* CurrentUser.current`. Remove the `Api` import only if nothing else in the file uses it (the HTTP group definitions likely still do).</action>
    <verify><automated>pnpm typecheck 2>&1 | grep -c 'packages/webhooks/src' ; npx vitest run packages/webhooks/test 2>&1 | tail -3   # src compiles; tests fixed in task 2</automated></verify>
    <acceptance_criteria>`rg -n 'Api\.UserPrincipal|caller\.ref\.id|\.principal\b' packages/webhooks/src/Webhooks.ts` prints nothing (baseline 11 + 5 + 9).</acceptance_criteria>
    <done>Webhooks src compiles against `CurrentUser.Caller`.</done>
  </task>
  <task type="auto">
    <name>Task 2: test helpers and changeset</name>
    <files>packages/webhooks/test/support.ts, packages/webhooks/test/WebhooksAdmin.test.ts, .changeset/current-user-caller-webhooks.md</files>
    <read_first>packages/webhooks/test/support.ts:170-182; packages/webhooks/test/WebhooksAdmin.test.ts:40-50, :380-395</read_first>
    <action>`adminPrincipal(id)` in support.ts returns `CurrentUser.of(new Api.UserPrincipal({...}))` (keep the name to limit churn, or rename to `adminCaller` and update its uses; pick one and record it in Comments). In WebhooksAdmin.test.ts wrap the two hand-built principals (:46, :387) with `CurrentUser.of(...)`. Do not change any assertion. Write `.changeset/current-user-caller-webhooks.md`: `"@awthaq/webhooks": minor`, `Migration: the webhooks admin operations take CurrentUser.Caller; pass CurrentUser.of(principal) or yield* CurrentUser.current.`</action>
    <verify><automated>npx vitest run packages/webhooks/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>No assertion line changed: `git diff -U0 packages/webhooks/test | grep -c '^[-+].*assert'` = 0.</acceptance_criteria>
    <done>Webhooks suite green, behaviour unchanged.</done>
  </task>
</tasks>

<threat_model>
## Trust edges
| Edge | Description |
|---|---|
| admin caller → webhooks admin gate | the caller id decides `canManageWebhooks`, the audit actor and the rate-limit bucket |

## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-03 | Repudiation | `auth.admin.actionDenied.adminUserId` | low | mitigate | value unchanged (`caller.userId` equals the former re-brand); existing denial tests unchanged |
| T-40-04 | Denial of service | admin rate-limit key | low | mitigate | key `{ userId }` string unchanged; existing limit tests unchanged |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>`caller: Api.UserPrincipal` in webhooks src: 0 (baseline 11); `caller.ref.id`: 0 (baseline 5); webhooks suite green with no assertion changed.</success_criteria>

## Comments
Result: all 11 admin operations take CurrentUser.Caller; adminId deleted; Users import dropped. Kept helper name `adminPrincipal` in support.ts (now returns CurrentUser.of(...)); no assertion changed. Webhooks suite green. Breakage outside scope: features/step-definitions/WebhooksOperationsSteps.ts (lines ~185-227) passes Api.UserPrincipal and needs CurrentUser.of(...).
