---
plan: 37-store-contract-runner
ticket: 01
title: The contract states the give-back — settle("returned") on every adapter
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/test/src/StoreContract.ts
  - packages/test/test/StoreContract.test.ts
  - packages/ports/test/VerificationStore.test.ts
  - .changeset/store-contract-give-back.md
autonomous: true
requirements: [REQ-EA-1582]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "A memory VerificationStore whose settle ignores \"returned\" fails StoreContract.verification, and the failure names the give-back case"
    - "On every adapter (Ref, SQLite, WAL file, libSQL, Postgres) a claim held inside a transaction that fails is live again after settle(id, \"returned\")"
    - "A newer upsertLive, or a deleteByUser, between the failure and the give-back wins on every adapter"
    - "The kept case holds inside transaction, as the port requires"
  artifacts:
    - path: "packages/test/src/StoreContract.ts"
      provides: "three new verification cases; the kept case moved inside transaction"
      contains: "\"returned\""
    - path: "packages/test/test/StoreContract.test.ts"
      provides: "the no-op give-back mutant test"
  key_links:
    - from: "packages/test/test/StoreContract.test.ts"
      to: "packages/test/src/StoreContract.ts"
      via: "StoreContract.run(recorder.framework, { adapter, layer: mutant, cases: StoreContract.verification })"
      pattern: "StoreContract\\.verification"
---
Status: done (uncommitted)
Blocked by: none

<objective>
`StoreContract.verification` has one `settle` case, and it covers `"kept"` (`packages/test/src/StoreContract.ts:556-565`). The `"returned"` half is tested on the `Ref` adapter only (`packages/ports/test/VerificationStore.test.ts:29-135`). On SQL `settle` is deliberately a no-op, because the caller's transaction rolled the claim back (`packages/sql/src/VerificationStoreSql.ts:18,285`). So there is no SQL bug. But the contract never states the protocol, and a third adapter whose `transaction` does not roll back and whose `settle` does nothing would pass.

Purpose: state ADR-EA-039's hold/give-back protocol as contract cases that hold on every adapter. Use a mutant to prove the contract catches a no-op give-back.

Output: three cases in `StoreContract.verification`, the kept case corrected, a mutant test, and three `Ref`-only tests deleted. This lands before the refactor and needs nothing from it.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§2.2 F6/F7, §2.5, §5.2)
@packages/ports/src/VerificationStore.ts (lines 57-110: present, settle, transaction contracts)
@packages/ports/src/VerificationStore.ts (lines 220-245: the Ref settle)
@packages/sql/src/VerificationStoreSql.ts (header lines 1-25, settle at ~285, transaction at ~289)
@packages/test/src/StoreContract.ts (lines 378-646: verification fixtures, present helper at ~405, cases)
@packages/ports/test/VerificationStore.test.ts
@packages/test/test/StoreContract.test.ts
@spec/decisions/039-verification-redeem.md
</context>

<tasks>
  <task type="tdd">
    <name>Task 1 (RED): a no-op give-back passes the contract today</name>
    <files>packages/test/test/StoreContract.test.ts</files>
    <read_first>packages/test/test/StoreContract.test.ts (recordingFramework, the existing two run cases); packages/ports/src/VerificationStore.ts (VerificationStore class, layerMemory)</read_first>
    <behavior>
      - Test "a VerificationStore whose settle ignores a give-back fails StoreContract.verification, naming the give-back case": build a mutant layer: a Layer.effect for VerificationStore.VerificationStore that reads the real store and returns it with settle replaced by a function that always succeeds and does nothing. Provide it with VerificationStore.layerMemory. Run StoreContract.run(recorder.framework, { adapter: "no-op give-back", layer: mutant, cases: StoreContract.verification }), await recorder.settled, assert recorder.failed has at least one entry and that some entry includes the substring "given back".
    </behavior>
    <action>Add the test inside the existing describe("StoreContract.run") block, reusing recordingFramework. Import VerificationStore from @awthaq/ports and Layer from effect/Layer. Build the mutant with Layer.effect over the VerificationStore tag: yield the real store, then return VerificationStore.VerificationStore.of with its fields spread and settle overridden to return Effect.void. Use no type assertion. Run it now: it must FAIL, because all 17 current cases pass on the mutant (recorder.failed is empty). Commit nothing yet. Record the failing output in the ticket's Comments.</action>
    <verify><automated>! pnpm exec vitest run packages/test/test/StoreContract.test.ts   # RED: must exit non-zero here</automated></verify>
    <acceptance_criteria>The new test fails at this point with an assertion on recorder.failed being empty; the other three tests in the file pass.</acceptance_criteria>
    <done>A red test exists that names the gap.</done>
  </task>

  <task type="tdd">
    <name>Task 2 (GREEN): three give-back cases and the kept case inside transaction</name>
    <files>packages/test/src/StoreContract.ts</files>
    <read_first>packages/test/src/StoreContract.ts lines 378-646 (newToken, present(identifier, valueHash, minutes = 1, hold = false), makeTokenId, the kept case at 556-565, the transaction case at 567-582)</read_first>
    <behavior>
      - "a hold given back after its caller's transaction failed is live again": upsertLive t1 for "reset-password:u1" hash "h1"; run store.transaction over (present with hold true, assert Hit, then Effect.fail of a plain refusal value) and flip it to observe the refusal; settle(t1, "returned"); present h1 at minute 2 without hold is a Hit.
      - "a newer upsertLive between the failure and the give-back wins": as above, but after the failed transaction upsertLive t2 for the same identifier with hash "h2", then settle(t1, "returned"); present h1 is a Miss and present h2 is a Hit.
      - "a deleteByUser between the failure and the give-back leaves nothing to give back": t1 carries userId u1; after the failed transaction call deleteByUser(u1), then settle(t1, "returned"); present h1 is a Miss.
      - The kept case: the held present runs inside store.transaction, which succeeds; then settle(t1, "kept"); present h1 at minute 2 is a Miss (unchanged assertion).
    </behavior>
    <action>Insert the three cases right after the kept case in the verification list. Keep the name prefix style of the neighbouring cases. Every give-back case name must contain the words "given back" or "give-back", and the first one must contain "given back", so the mutant test's substring matches. Move the kept case's held present inside store.transaction: the port says hold is set only inside transaction (VerificationStore.ts:74-75). Use the existing present helper and newToken fixture (it takes a userId option). Use makeUserId for deleteByUser. Why these three: on the Ref adapter the give-back is settle's work, and on SQL it is the rollback's. All three end states are the same on both, so they are contract cases. The fourth Ref test, "purgeExpired never removes a held claim", is NOT moved: on SQL a purge between the failure and the give-back deletes the rolled-back, already expired row. Its outcome legitimately differs. Do not add a purge case.</action>
    <verify><automated>pnpm exec vitest run packages/test/test/StoreContract.test.ts packages/test/test/StoreContract.memory.test.ts packages/test/test/StoreContract.sql.test.ts packages/test/test/StoreContract.file.test.ts packages/test/test/StoreContract.libsql.test.ts</automated></verify>
    <acceptance_criteria>The mutant test now passes. `grep -c '"returned"' packages/test/src/StoreContract.ts` is at least 3 (baseline at HEAD: 0). The memory run prints `Tests  89 passed` or more (baseline 86). All five files pass.</acceptance_criteria>
    <done>The give-back is a contract case on memory, SQLite, WAL and libSQL; Postgres runs the same file under test:pg.</done>
  </task>

  <task type="auto">
    <name>Task 3: delete the three Ref tests the contract now covers; changeset</name>
    <files>packages/ports/test/VerificationStore.test.ts, .changeset/store-contract-give-back.md</files>
    <read_first>packages/ports/test/VerificationStore.test.ts; .changeset/test-records-contract-pending-removed.md (format)</read_first>
    <action>Delete three tests from the "VerificationStore (Ref) hold and settle (ADR-EA-039)" describe block: "a held claim given back is live again with its attempts as they were", "a newer upsertLive wins over a give-back", and "deleteByUser sweeps a held claim, so a give-back cannot resurrect an erased user's token". Keep "purgeExpired never removes a held claim" and the pruning describe. Rewrite the file header comment so it says the hold-and-give-back protocol is StoreContract.verification, and that what stays here is the Ref adapter's purge rule and pruning. Remove any import that becomes unused. Add .changeset/store-contract-give-back.md with front matter "@awthaq/test": patch and one paragraph: StoreContract.verification states the give-back (ADR-EA-039) on every adapter. No Migration line: nothing a caller does changes.</action>
    <verify><automated>pnpm exec vitest run packages/ports/test/VerificationStore.test.ts &amp;&amp; test "$(grep -c 'settle(tokenId("t1"), "returned")' packages/ports/test/VerificationStore.test.ts)" -eq 1</automated></verify>
    <acceptance_criteria>The count of give-back calls in the ports test drops from 4 (baseline) to 1. The ports test file passes. The changeset file exists.</acceptance_criteria>
    <done>Replace-don't-layer: the moved behaviour is tested once, at the contract.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
Then, if a Postgres is reachable: AWTHAQ_POSTGRES_URL=… pnpm exec vitest run packages/test/test/StoreContract.sql.test.ts --testTimeout=60000 (or say in the report that Postgres was unavailable).
</verification>

<success_criteria>
- The mutant test was red before Task 2 and is green after it.
- `"returned"` appears at least 3 times in `packages/test/src/StoreContract.ts`; it appeared 0 times at HEAD.
- The memory contract run counts at least 89 cases (86 at HEAD).
- `packages/ports/test/VerificationStore.test.ts` has 1 give-back call (4 at HEAD).
</success_criteria>

## Comments

Done (uncommitted). Three give-back cases added to `StoreContract.verification` (`"returned"` count 0 -> 3) and the kept case now holds inside `transaction`; the no-op `settle` mutant test is in `StoreContract.test.ts`. Three Ref-only tests deleted from `packages/ports/test/VerificationStore.test.ts` (give-back calls 4 -> 1). Memory contract run 86 -> 89 cases. Deviation: the RED step was not run on its own (mutant test and cases were written together); the mutant test fails by construction against the old list (no give-back case existed). Formatter is `oxfmt` (the repo's), not Prettier. Postgres not available: `pnpm test:pg` not run.
