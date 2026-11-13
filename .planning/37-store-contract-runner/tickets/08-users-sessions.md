---
plan: 37-store-contract-runner
ticket: 08
title: users and sessions as verdict suites
type: execute
wave: 5
depends_on: [07]
files_modified:
  - packages/test/src/internal/storeContract/users.ts
  - packages/test/src/internal/storeContract/sessions.ts
  - packages/test/test/support/storeContract.ts
autonomous: true
requirements: [REQ-EA-1583]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "All 11 UserStore and 9 SessionStore operations carry a verdict (44 of the 44 core operations in total)"
    - "UserStore.delete and UserStore.writeFields each have their own race case (the shared case at HEAD :1425 is split)"
    - "The sealed bundle runs the users and sessions suites through runSuite"
    - "No case was lost (stripped name sets identical except recorded splits)"
  artifacts:
    - path: "packages/test/src/internal/storeContract/users.ts"
      provides: "users = suite(UserStore.UserStore, …), R = SqlTransaction.SqlTransaction; userFieldColumns"
    - path: "packages/test/src/internal/storeContract/sessions.ts"
      provides: "sessions = suite(SessionStore.SessionStore, …)"
  key_links:
    - from: "packages/test/test/support/storeContract.ts"
      to: "packages/test/src/StoreContract.ts"
      via: "runSuite for users and sessions on Ref, SQL and the encryptPii bundle"
      pattern: "suite: StoreContract\\.(users|sessions)"
---
Status: done (uncommitted)
Blocked by: 07

<objective>
Convert the two largest ports (UserStore 16 cases, SessionStore 22 cases). Split the one race case that proves two operations, so each atomic operation has its own race.

Purpose: every core store operation carries a verdict. After this ticket the old list shape has no user left, except the old `run` itself, which ticket 09 removes.

Output: two suites, and the support file running them through `runSuite`, the sealed run included.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§2.3)
@packages/ports/src/UserStore.ts (lines 95-175)
@packages/ports/src/SessionStore.ts (lines 95-195)
@packages/test/src/internal/storeContract/users.ts
@packages/test/src/internal/storeContract/sessions.ts
@packages/test/src/internal/storeContract/verification.ts (converted shape)
@packages/test/test/support/storeContract.ts
</context>

<tasks>
  <task type="auto">
    <name>Task 1: users, with the delete/writeFields race split</name>
    <files>packages/test/src/internal/storeContract/users.ts, packages/test/test/support/storeContract.ts</files>
    <read_first>packages/test/src/internal/storeContract/users.ts (the case "delete under concurrency removes the row exactly once, and writeFields racing it never orphans a field"); packages/ports/src/UserStore.ts lines 95-175</read_first>
    <action>Save the baseline names as in ticket 06 Task 1, then regroup into suite(UserStore.UserStore, …) with R set to SqlTransaction.SqlTransaction. The verdicts: insertOrHolder is atomic (stores and stamps; answers Held; leaves an enclosing transaction usable) with race (8 inserts of one email). get, getByEmail and getByPhone are read; the directory-global case goes under get, and "getByEmail and getByPhone find the holder…" is split per operation. updateProfile is write (two cases). casIdentity is atomic (two cases) with race (8 identical verifications). setStatus is write. delete is atomic (removes the user and its declared fields…) with race "delete under concurrency removes the row exactly once". writeFields is atomic (returns its own post-state…) with race "writeFields racing delete never orphans a field". Those last two come from splitting the one case at HEAD :1425 into its two assertions. listPage is read. readFields is read: give it its own case asserting None for an absent user and the set columns for a present one. At HEAD it is only exercised inside the writeFields case. Record each split and the new readFields case in Comments. In the support file, switch the UserStore blocks to runSuite in all three runners (Ref, SQL, sealed).</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.sealed.test.ts</automated></verify>
    <acceptance_criteria>The three files pass. `grep -c 'race:' packages/test/src/internal/storeContract/users.ts` is at least 4 (insertOrHolder, casIdentity, delete, writeFields).</acceptance_criteria>
    <done>UserStore carries verdicts.</done>
  </task>

  <task type="auto">
    <name>Task 2: sessions</name>
    <files>packages/test/src/internal/storeContract/sessions.ts, packages/test/test/support/storeContract.ts</files>
    <read_first>packages/test/src/internal/storeContract/sessions.ts; packages/ports/src/SessionStore.ts lines 95-195</read_first>
    <action>Regroup into suite(SessionStore.SessionStore, …). The verdicts: insert is atomic (founds a family; supersedes; foreign or tombstoned supersedes; the maxLive eviction; an acting-as insert) with race (both concurrency cases). get is read: the "insert founds a family… and get round-trips every field" case goes under insert, and get gets a case of its own that reads a stored row back and reads None for an absent id. rotate is atomic (two) with race. flagReuse is atomic (two) with race. remove is atomic with race. removeForUser is write. listLive is read (two). reauthenticate is atomic (advances and unions; refuses) with race. purgeExpired is write. Record the new get case in Comments. In the support file, switch the SessionStore blocks to runSuite in all three runners. After this, support calls the old StoreContract.run nowhere.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts packages/test/test/StoreContract.sealed.test.ts &amp;&amp; test "$(grep -c 'StoreContract.run(' packages/test/test/support/storeContract.ts)" -eq 0</automated></verify>
    <acceptance_criteria>All five files pass. The support file holds no StoreContract.run( call. The baseline at HEAD is 14 such calls (6 memory, 6 sql, 2 sealed).</acceptance_criteria>
    <done>SessionStore carries verdicts; every core port is a suite.</done>
  </task>

  <task type="auto">
    <name>Task 3: prove no case was lost</name>
    <files>(none; verification only)</files>
    <read_first>the baseline list from Task 1; Comments</read_first>
    <action>Diff the stripped sorted names against the baseline. The only allowed differences are the splits and new cases recorded in Comments. Count the memory run.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts --reporter=verbose 2&gt;&amp;1 | grep -cE '(UserStore|SessionStore) \(Ref\) &gt; [a-zA-Z]+ \[(read|write|atomic|race)\]'</automated></verify>
    <acceptance_criteria>The command prints 38 or more (16 + 22 at HEAD; splits add rows). The diff shows only the recorded changes.</acceptance_criteria>
    <done>44 of 44 core operations carry verdicts.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 44 of 44 core operations carry verdicts; every `atomic` has a `race`.
- `StoreContract.run(` calls in the support file: 14 → 0.
- Sealed run green on SQLite.
</success_criteria>

## Comments

Done (uncommitted). users (11 ops, `SqlTransaction` as explicit R) and sessions (9 ops) are suites; the old `StoreContract.run(` calls in the support file: 14 -> 0 (the export itself stays until ticket 09 and is still used by `StoreContract.test.ts`). Splits/new cases (old -> new): `getByEmail and getByPhone find...` -> one case each; `delete under concurrency ... and writeFields racing it...` -> `delete under concurrency removes the row exactly once` + `writeFields racing delete never orphans a field`; NEW `readFields reads the requested declared columns...`; NEW sessions `get reads a stored row back by id and is None for an absent id`. Counts: memory run 97 cases (86 at HEAD); 42 `(UserStore|SessionStore) (Ref)` verdict rows. Gates run: vitest packages/test/test (598 pass, 1 expected fail), `tsc -b`, `tsc -p tsconfig.test.json`, scripts/circular.mjs. Not run: pnpm test:pg (no Postgres), full pnpm test, lint, knip.
