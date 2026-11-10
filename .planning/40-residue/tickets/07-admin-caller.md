---
plan: 40-residue
ticket: 07
title: "Admin, AdminAccounts, AdminTenants and the admin gate take CurrentUser.Caller"
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/admin/src/Admin.ts
  - packages/admin/src/AdminAccounts.ts
  - packages/admin/src/AdminTenants.ts
  - packages/admin/src/internal/AdminGate.ts
  - packages/admin/test/Admin.test.ts
  - packages/admin/test/AdminAccounts.test.ts
  - packages/admin/test/AdminConfig.test.ts
  - packages/admin/test/AdminGate.test.ts
  - packages/admin/test/AdminGate.types.test.ts
  - packages/admin/test/AdminTenants.test.ts
  - packages/admin/test/AdminTier.test.ts
  - packages/admin/test/AdminUsers.test.ts
  - .changeset/current-user-caller-admin.md
autonomous: true
requirements: [REQ-EA-1611]
estimate: {tasks: 3, size: L}
must_haves:
  truths:
    - "AdminShape, AdminAccountsShape, AdminTenantsShape and the gate take `caller: CurrentUser.Caller`"
    - "Impersonation: self-impersonation refused, nested impersonation refused (caller.actingAs Some), stopImpersonating without actingAs is AdminImpersonationNotFound, the issued session's actingAs is { type: 'user', id: caller.userId } (BEH-EA-209..218)"
    - "Every admin test assertion is unchanged; only caller helpers change"
  artifacts:
    - path: packages/admin/src/Admin.ts
      provides: "AdminShape over CurrentUser.Caller"
  key_links:
    - from: packages/admin/src/Admin.ts
      to: packages/admin/src/internal/AdminGate.ts
      via: "gate.* receive the Caller; gate reads caller.userId"
      pattern: "caller: CurrentUser\\.Caller"
---
Status: ready-for-agent
Blocked by: 01

<objective>
The admin plugins stop taking the wire principal.
Purpose: 30 `caller: Api.UserPrincipal` parameters and 28 `caller.ref.id` reads across admin (PLAN §2.A.3). The gate itself belongs to plan 31; this ticket changes only its caller parameter type and the id read.
Output: `CurrentUser.Caller` through `Admin`, `AdminAccounts`, `AdminTenants` and the gate; the 18 handlers pass `yield* CurrentUser.current`.
Split rule waived (PLAN §4.3): one parameter type every caller and test helper must follow in one commit.
</objective>

<context>
@packages/admin/src/Admin.ts (shape :50-200, handlers :270-395, impersonate :852-890, stopImpersonating :921-945)
@packages/admin/src/AdminAccounts.ts (:60-95, :105-140, :165-270)
@packages/admin/src/AdminTenants.ts (:40-80, :105-160)
@packages/admin/src/internal/AdminGate.ts (:255-415)
@packages/core/src/CurrentUser.ts (after ticket 01)
@.planning/40-residue/PLAN.md §2.A.3, §3.A, §8 (plan 31)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: the gate's caller parameter</name>
    <files>packages/admin/src/internal/AdminGate.ts</files>
    <read_first>packages/admin/src/internal/AdminGate.ts in full; `git log --oneline -5 -- packages/admin/src/internal/` (plan 31 may have changed or moved the gate)</read_first>
    <precondition>No unmerged plan-31 branch edits the admin gate: `git branch -a --list '*admin-tier-gate*'` prints nothing, or each printed branch is in `git branch --merged`. If plan 31 has landed and moved the gate, edit every file that `rg -l 'caller: Api\.UserPrincipal' packages/admin/src` lists instead of the path above and record the paths in Comments.</precondition>
    <action>Replace each `caller: Api.UserPrincipal` (10) with `caller: CurrentUser.Caller`. Replace `Users.UserId(caller.ref.id)` (7) with `caller.userId` and `subject(caller.ref.id)` (6) with `subject(caller.userId)`. Change nothing else in the gate (its logic is plan 31's).</action>
    <verify><automated>rg -n 'caller\.ref\.id|Api\.UserPrincipal' packages/admin/src/internal/AdminGate.ts | wc -l   # baseline 23, expect 0</automated></verify>
    <done>The gate reads `caller.userId` only.</done>
  </task>
  <task type="auto">
    <name>Task 2: Admin, AdminAccounts, AdminTenants</name>
    <files>packages/admin/src/Admin.ts, packages/admin/src/AdminAccounts.ts, packages/admin/src/AdminTenants.ts</files>
    <read_first>the line ranges in context</read_first>
    <action>Replace every `caller: Api.UserPrincipal` (Admin 13, AdminAccounts 3, AdminTenants 4) with `caller: CurrentUser.Caller`. Admin.ts: `Users.UserId(caller.ref.id)` → `caller.userId` (7); `caller.ref.id === userId` / `=== targetUserId` → `caller.userId === …` (:762, :860); `caller.actingAs !== undefined` (:863) → `Option.isSome(caller.actingAs)`; `caller.actingAs === undefined` (:925) → `Option.isNone(caller.actingAs)`; `actingAs: { type: caller.ref.type, id: caller.ref.id }` (:873) → `actingAs: { type: "user", id: caller.userId }` (both shipped principal producers set "user", PLAN §2.A.3); in stopImpersonating `Sessions.SessionId(caller.sessionId)` (:939) → `caller.sessionId`, and `revokeQuietly`/`endEpisode`/the log line take `caller.sessionId` as is. AdminAccounts.ts: same id replacements (:169, :185, :216, :225, :265). In the 18 handlers (Admin.ts :278-384, AdminAccounts.ts :112-132, AdminTenants.ts :114-151) replace `const { principal: caller } = yield* CurrentUser.current` with `const caller = yield* CurrentUser.current`; `params.sessionId === caller.sessionId` (:300) stays. Keep `Api` imports only where still used.</action>
    <verify><automated>rg -n 'caller\.ref\.|Api\.UserPrincipal|principal: caller' packages/admin/src | wc -l   # baseline 78 at HEAD (55 once task 1 is done), expect 0; then pnpm typecheck</automated></verify>
    <acceptance_criteria>`rg -c 'caller\.ref\.id' packages/admin/src` prints nothing (baseline 28); `rg -c 'caller: Api\.UserPrincipal' packages/admin/src` prints nothing (baseline 30).</acceptance_criteria>
    <done>Admin src compiles.</done>
  </task>
  <task type="auto">
    <name>Task 3: test caller helpers and changeset</name>
    <files>packages/admin/test/Admin.test.ts, packages/admin/test/AdminAccounts.test.ts, packages/admin/test/AdminConfig.test.ts, packages/admin/test/AdminGate.test.ts, packages/admin/test/AdminGate.types.test.ts, packages/admin/test/AdminTenants.test.ts, packages/admin/test/AdminTier.test.ts, packages/admin/test/AdminUsers.test.ts, .changeset/current-user-caller-admin.md</files>
    <read_first>each helper: Admin.test.ts:50-60, AdminAccounts.test.ts:99, AdminConfig.test.ts:28, AdminGate.test.ts:96, AdminGate.types.test.ts:12, AdminTenants.test.ts:30, AdminTier.test.ts:88, AdminUsers.test.ts:36</read_first>
    <action>Each `asCaller`/builder returns `CurrentUser.of(new Api.UserPrincipal({...}))` with its return type `CurrentUser.Caller`; `AdminGate.types.test.ts:12` declares `caller: CurrentUser.Caller`. A builder that sets `actingAs` on the principal keeps it (it flows into `Caller.actingAs`). Change no assertion. Changeset `.changeset/current-user-caller-admin.md`: `"@awthaq/admin": minor`, `Migration: Admin, AdminAccounts and AdminTenants operations take CurrentUser.Caller; pass CurrentUser.of(principal) or yield* CurrentUser.current.`</action>
    <verify><automated>npx vitest run packages/admin/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>`git diff -U0 packages/admin/test | grep -c '^[-+].*assert'` = 0; `rg -c 'Api\.UserPrincipal' packages/admin/test` equals the number of helpers (each still builds a principal inside `CurrentUser.of`).</acceptance_criteria>
    <done>Admin suite green with unchanged assertions.</done>
  </task>
</tasks>

<threat_model>
## Trust edges
| Edge | Description |
|---|---|
| admin caller → admin gate | the caller id and the impersonation marker decide clearance, self-action refusals and nested impersonation |

## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-06 | Elevation of privilege | `Admin.impersonate` nested check | high | mitigate | `Option.isSome(caller.actingAs)`; BEH-EA-214 test unchanged and green |
| T-40-07 | Elevation of privilege | self-ban / self-impersonation | medium | mitigate | comparisons on branded `caller.userId`; tests at Admin.test.ts unchanged |
| T-40-08 | Repudiation | audit rows and events `adminUserId` | low | mitigate | same value as the former re-brand; event tests unchanged |
| T-40-09 | Spoofing | impersonation session `actingAs.type` | low | accept | `"user"` literal; both producers emit "user"; `refuseSelfActingAs` already assumes it |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>A2 gate for admin = 0 (baseline 28); A3 gate for admin = 0 (baseline 30); admin suite green, zero assertion lines changed.</success_criteria>

## Comments
