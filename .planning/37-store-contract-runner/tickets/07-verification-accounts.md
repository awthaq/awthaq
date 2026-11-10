---
plan: 37-store-contract-runner
ticket: 07
title: verification and accounts as verdict suites
type: execute
wave: 4
depends_on: [06]
files_modified:
  - packages/test/src/internal/storeContract/verification.ts
  - packages/test/src/internal/storeContract/accounts.ts
  - packages/test/test/support/storeContract.ts
  - packages/test/test/StoreContract.test.ts
autonomous: true
requirements: [REQ-EA-1583]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "All 7 VerificationStore operations and all 10 AccountStore operations carry a verdict"
    - "upsertLive, present, reserve, insertIfAbsent and deleteUnlessLast are atomic with a race case"
    - "settle carries the kept case and the three give-back cases from ticket 01"
    - "No case was lost (stripped name sets identical)"
  artifacts:
    - path: "packages/test/src/internal/storeContract/verification.ts"
      provides: "verification = suite(VerificationStore.VerificationStore, …)"
    - path: "packages/test/src/internal/storeContract/accounts.ts"
      provides: "accounts = suite(AccountStore.AccountStore, …), R = SqlTransaction.SqlTransaction"
  key_links:
    - from: "packages/test/test/support/storeContract.ts"
      to: "packages/test/src/StoreContract.ts"
      via: "runSuite for VerificationStore and AccountStore on Ref and SQL"
      pattern: "suite: StoreContract\\.(verification|accounts)"
---
Status: done (uncommitted)
Blocked by: 06

<objective>
Convert the next two ports with the shape the tracer proved.

Purpose: 17 more operations carry compile-checked verdicts.

Output: two suites, and the support file running them through `runSuite`.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§2.3)
@packages/ports/src/VerificationStore.ts (lines 57-130)
@packages/ports/src/AccountStore.ts (lines 90-150)
@packages/test/src/internal/storeContract/verification.ts
@packages/test/src/internal/storeContract/accounts.ts
@packages/test/src/internal/storeContract/relayCursor.ts (the converted shape from ticket 06)
@packages/test/test/support/storeContract.ts
</context>

<tasks>
  <task type="auto">
    <name>Task 1: verification</name>
    <files>packages/test/src/internal/storeContract/verification.ts, packages/test/test/support/storeContract.ts, packages/test/test/StoreContract.test.ts</files>
    <read_first>packages/test/src/internal/storeContract/verification.ts; packages/ports/src/VerificationStore.ts lines 57-130</read_first>
    <action>Save the baseline names as in ticket 06 Task 1. Then regroup into suite(VerificationStore.VerificationStore, …) with these verdicts. upsertLive: atomic (stores, replaces, keeps history) and race (8 racing values). present: atomic (Hit once, never matches, refuses expired, spends an attempt, fewer misses leave it usable) and race (the 8-way Hit race and the budget-overshoot race). settle: write (kept, plus ticket 01's three give-back cases). transaction: write (runs its body once…). reserve: atomic (exclusive while live…) and race (8 claims). deleteByUser: write. purgeExpired: write. In the support file, switch the VerificationStore Ref and SQL blocks to runSuite. In StoreContract.test.ts, ticket 01's no-op give-back mutant test passes StoreContract.verification as cases to the old run. Change it to StoreContract.runSuite with suite: StoreContract.verification, keeping its assertions.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts</automated></verify>
    <acceptance_criteria>Every VerificationStore test is prefixed with one of its 7 operations. The mutant test passes: the mutant still fails, and the failure names the give-back case.</acceptance_criteria>
    <done>VerificationStore carries verdicts.</done>
  </task>

  <task type="auto">
    <name>Task 2: accounts</name>
    <files>packages/test/src/internal/storeContract/accounts.ts, packages/test/test/support/storeContract.ts</files>
    <read_first>packages/test/src/internal/storeContract/accounts.ts; packages/ports/src/AccountStore.ts lines 90-150</read_first>
    <action>Regroup into suite(AccountStore.AccountStore, …) with R set to SqlTransaction.SqlTransaction, because two cases open an enclosing transaction. The verdicts: insertIfAbsent is atomic (stores and stamps; loses a race inside an enclosing transaction and leaves it usable; exclusive per key) with race (8 inserts). getByKey, get and listByUser are read. readCredentialHash and readProviderTokens are read. writeCredentialHash and writeProviderTokens are write. deleteUnlessLast is atomic (deletes a sibling, refuses the last…) with race (two unlinks). deleteByUser is write. A case proves several reads: "get, getByKey and listByUser read the identity…", and "getByKey and listByUser are global across tenants". List it under the first operation named, and split it so each other operation has its own case: keep the assertions and divide them. The same goes for "writeCredentialHash and writeProviderTokens replace the value…". Splitting changes the stripped name set. Record each split in Comments as old name → new names, and accept the diff only for those. Switch the AccountStore blocks in support to runSuite.</action>
    <verify><automated>pnpm typecheck &amp;&amp; pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts packages/test/test/StoreContract.test.ts</automated></verify>
    <acceptance_criteria>All five files pass. AccountStore's 10 operations each have at least one case.</acceptance_criteria>
    <done>AccountStore carries verdicts.</done>
  </task>

  <task type="auto">
    <name>Task 3: prove no case was lost</name>
    <files>(none; verification only)</files>
    <read_first>the baseline list from Task 1; Comments (the recorded splits)</read_first>
    <action>Diff the stripped sorted names against the baseline. The only differences allowed are the splits recorded in Comments.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/StoreContract.memory.test.ts --reporter=verbose 2&gt;&amp;1 | grep -cE 'VerificationStore \(Ref\) &gt; [a-zA-Z]+ \[(read|write|atomic|race)\]'</automated></verify>
    <acceptance_criteria>The command prints 20 or more: 17 cases at HEAD plus ticket 01's 3 (baseline 0 with a prefix). The diff shows only the recorded splits.</acceptance_criteria>
    <done>24 of 46 operations carry verdicts.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 24 of 46 operations carry verdicts after this ticket (7 + 7 + 10).
- Stripped name sets identical except recorded splits.
- The no-op give-back mutant still fails, now through `runSuite`.
</success_criteria>

## Comments

Done (uncommitted). verification (7 ops, 20 cases) and accounts (10 ops) are suites; accounts passes `SqlTransaction` as explicit `R` (inference failed). Verification names identical after stripping. Accounts splits (old -> new): `getByKey and listByUser are global across tenants` -> `getByKey is global...` + `listByUser is global...`; `get, getByKey and listByUser read the identity...` -> `listByUser is the user's own...` + `get reads the identity by id...` + `getByKey reads the identity by (providerId, subject, issuer)...`; `writeCredentialHash and writeProviderTokens replace...` -> one case per operation. Mutant test now goes through `runSuite` and still fails naming the give-back case.
