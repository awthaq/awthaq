---
plan: 40-residue
ticket: 01
title: "CurrentUser.Caller and CurrentUser.of; the GC-003 test moves to core"
type: tdd
wave: 1
depends_on: []
files_modified:
  - packages/core/src/CurrentUser.ts
  - packages/core/test/CurrentUser.test.ts
  - packages/server/test/AuthHttp.test.ts
autonomous: true
requirements: [REQ-EA-1610]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "CurrentUser.of(principal) returns { userId, sessionId, actingAs } with userId/sessionId branded from ref.id/sessionId and actingAs Some({type,id}) iff the principal carries actingAs"
    - "CurrentUser.current returns the fields of of(principal) plus, for this migration only, `principal`"
    - "CurrentUser.current dies Defects/InvariantViolation NonUserPrincipal on a non-User principal, tested in core"
  artifacts:
    - path: packages/core/src/CurrentUser.ts
      provides: "Caller interface, of, current"
      contains: "export interface Caller"
    - path: packages/core/test/CurrentUser.test.ts
      provides: "GC-003 at CurrentUser's own interface"
  key_links:
    - from: packages/core/src/CurrentUser.ts
      to: packages/core/src/Sessions.ts
      via: "Caller.actingAs is Option<Sessions.ActingAs>"
      pattern: "Option\\.Option<Sessions\\.ActingAs>"
---
Status: ready-for-agent
Blocked by: none

<objective>
Give GC-003 a domain caller type and a single re-brand function, so later tickets can stop reading the wire principal.
Purpose: `CurrentUser.current` re-brands once, but hands the wire `principal` back, and 17 handlers plus four admin-tier modules re-brand it again (PLAN §2.A). This ticket adds the type every one of them will take.
Output: `CurrentUser.Caller`, `CurrentUser.of`, `current` built on `of`; the GC-003 defect test lives in core.
</objective>

<context>
@packages/core/src/CurrentUser.ts
@packages/core/src/Sessions.ts (ActingAs at :126-129, SessionView.actingAs at :187)
@packages/api/src/Api.ts (UserPrincipal at :23-42, PrincipalRef at :18-21)
@packages/server/test/AuthHttp.test.ts (:687-711, the GC-003/GC-008 describe block)
@.planning/40-residue/PLAN.md §3.A
</context>

<tasks>
  <task type="tdd">
    <name>Task 1: red tests for Caller/of/current in core</name>
    <files>packages/core/test/CurrentUser.test.ts</files>
    <read_first>packages/server/test/AuthHttp.test.ts lines 687-711; packages/core/test/Users.test.ts (imports and `it.effect` style)</read_first>
    <behavior>
      - of(new Api.UserPrincipal({ ref: {type:"user", id:"u1"}, sessionId: "s1" })) gives userId "u1", sessionId "s1", actingAs None.
      - with actingAs PrincipalRef {type:"user", id:"admin-1"}: actingAs is Some({ type: "user", id: "admin-1" }).
      - current, with Api.CurrentPrincipal provided as that UserPrincipal, yields userId/sessionId/actingAs equal to of(principal).
      - current with an ApiKeyPrincipal dies with Defects.InvariantViolation whose invariant is "NonUserPrincipal" (move the assertions of AuthHttp.test.ts:687-711 verbatim).
    </behavior>
    <action>Create packages/core/test/CurrentUser.test.ts with @effect/vitest `describe`/`it.effect`, importing `CurrentUser` from "../src/CurrentUser.ts", `Api` from "@awthaq/api", `Defects` from "@awthaq/ports". Write the four cases above. Then delete the whole `describe("server handler invariants (GC-003/GC-008)", ...)` block from packages/server/test/AuthHttp.test.ts (replace, don't layer) and any import it alone used (check `Cause`, `Exit`, `Defects` are still used elsewhere in that file before removing them). Run the new file: it fails to compile on `CurrentUser.of`/`actingAs` (red).</action>
    <verify><automated>npx vitest run packages/core/test/CurrentUser.test.ts 2>&1 | tail -5   # expected RED before task 2</automated></verify>
    <acceptance_criteria>The new file exists with four cases; `rg -n 'GC-003/GC-008' packages/server/test/AuthHttp.test.ts` prints nothing (baseline at HEAD: 1 line, :687).</acceptance_criteria>
    <done>Red tests committed alongside task 2.</done>
  </task>
  <task type="auto">
    <name>Task 2: Caller, of, current</name>
    <files>packages/core/src/CurrentUser.ts</files>
    <read_first>packages/core/src/CurrentUser.ts; packages/core/src/Sessions.ts:120-190</read_first>
    <action>In CurrentUser.ts declare and export `interface Caller` with readonly `userId: Users.UserId`, `sessionId: Sessions.SessionId`, `actingAs: Option.Option<Sessions.ActingAs>` (doc comments: GC-003; BEH-EA-211 for actingAs). Export `of`, a plain function from `Api.UserPrincipal` to `Caller` (a function's parameter and return may be typed; it is not an Effect const): `userId: Users.UserId(principal.ref.id)`, `sessionId: Sessions.SessionId(principal.sessionId)`, `actingAs: Option.map(Option.fromNullishOr(principal.actingAs), (ref) => ({ type: ref.type, id: ref.id }))`. Rewrite `current` so that after the non-User check it returns `{ ...of(principal), principal }`; leave `current` un-annotated. Add one line above the spread: the `principal` field is kept only until plan 40 ticket 09 removes it. Update the module header comment: `of` is the one re-brand. No `as`.</action>
    <verify><automated>npx vitest run packages/core/test/CurrentUser.test.ts packages/server/test/AuthHttp.test.ts && pnpm typecheck</automated></verify>
    <acceptance_criteria>`rg -c 'Users\.UserId\(principal\.ref\.id\)' packages/core/src/CurrentUser.ts` = 1 (baseline 1, unchanged: the one site is now inside `of`); `rg -n 'export interface Caller|export const of' packages/core/src/CurrentUser.ts` prints 2 lines (baseline 0).</acceptance_criteria>
    <done>Core tests green; every existing reader of `current` still compiles because `principal` is still there.</done>
  </task>
</tasks>

<threat_model>
## Trust edges
| Edge | Description |
|---|---|
| verified session → domain | `Api.CurrentPrincipal` (set by `Authentication`) becomes the caller every gate reads |

## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-01 | Elevation of privilege | `CurrentUser.of` dropping `actingAs` | high | mitigate | Task 1 tests both arms; ticket 07 keeps BEH-EA-214 (no nested impersonation) green |
| T-40-02 | Spoofing | a non-User principal reaching a user-tier group | medium | mitigate | `current` keeps the `NonUserPrincipal` defect; tested in core |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular  (knip: pass if every reported file is under .reports/)</verification>

<success_criteria>`CurrentUser.Caller` and `CurrentUser.of` exported from `@awthaq/core`; 4 new core tests green; the server GC-003 block deleted; full gate green.</success_criteria>

## Comments
