---
phase: 06-record-store-scaffolding
reviewed: 2026-11-14T00:00:00Z
depth: deep
files_reviewed: 30
files_reviewed_list:
  - .changeset/record-store-helpers.md
  - packages/admin/src/ImpersonationRecords.ts
  - packages/api-key/src/ApiKeyClientRecords.ts
  - packages/api-key/src/ApiKeyRecords.ts
  - packages/device-authorization/src/DeviceClientRecords.ts
  - packages/device-authorization/src/DeviceGrantRecords.ts
  - packages/jwt/src/SigningKeyRecords.ts
  - packages/organization/src/ActiveContextRecords.ts
  - packages/organization/src/ConnectionRecords.ts
  - packages/organization/src/InvitationRecords.ts
  - packages/organization/src/MembershipRecords.ts
  - packages/organization/src/OrgRoleRecords.ts
  - packages/organization/src/OrganizationRecords.ts
  - packages/organization/src/TeamRecords.ts
  - packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts
  - packages/organization/test/RecordOrderPins.test.ts
  - packages/ports/src/Keyset.ts
  - packages/ports/test/Keyset.test.ts
  - packages/saml/src/SamlRecords.ts
  - packages/saml/test/RecordOrderPins.test.ts
  - packages/scim/src/ScimRecords.ts
  - packages/scim/test/RecordOrderPins.test.ts
  - packages/sql/src/StoreFailure.ts
  - packages/sql/test/RecordsScaffoldPins.test.ts
  - packages/sql/test/StoreFailure.test.ts
  - packages/webhooks/src/WebhookRecords.ts
  - packages/webhooks/test/RecordOrderPins.test.ts
  - spec/decisions/041-domain-store-ports.md
  - spec/overview.md
  - spec/traceability.md
findings:
  critical: 0
  warning: 2
  info: 4
  total: 6
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** deep
**Files Reviewed:** 30
**Status:** issues_found

## Summary

Reviewed `git diff 3be32564 HEAD -- packages spec .changeset` against the pre-change comparator and closure text, with the effect 4.1.2 `Order`/`DateTime.Order` sources read to confirm the helper's semantics.

No behaviour regression found on the canonical-id path. What was checked and holds:

- **Label closure equivalence:** `labelled(store)(op)` builds `orStoreUnavailable(`${store}.${op}`)`, the exact string every removed closure built. All 16 store-name literals match their module. The `typeof orStoreUnavailable` return type is the same shape. Webhook's `failing` binding keeps its name. No `as` was added in any `packages/*/src` diff.
- **Order equivalence:** `DateTime.Order` compares `epochMilliseconds`, `Order.String` is `<`/`>` on code units, and `Order.flip` of the combined order is the exact `desc` of the removed comparators.
  - ApiKeyClient and ApiKey `newestFirst` (b-a, then `a.id < b.id ? 1 : -1`) are the same order.
  - DeviceClient is the same.
  - Membership `sort asc` then `.reverse()` equals `flip(asc)` (the full tuple is unique, so no stability difference).
  - Team `listTeamsByOrganization` is the same (it was already `<`).
- **Imports and strata:** `@awthaq/ports` is declared in `device-authorization` and `organization` (the two packages that gained the import), and the tsconfig references exist. `ports` gains only an `effect/DateTime` import, so no cycle.
- **Changeset:** both new exports get `minor`, adopters get `patch`. All 8 changed packages are listed. The `fixed` group in `.changeset/config.json` lifts the whole set in lockstep anyway.
- **F-06-01 fix:** the advisory-lock predicate is correct (`objsubid = 1`, `classid`/`objid` are the high and low 32 bits of the bigint). The text key is hashed with `hashtextextended(key, 0)`, matching `SqlStore.ts:71`.
- **Tests run:** the 7 new or extended test files (52 tests) pass on SQLite here.

The remaining issues are in the oracle design and in an unpinned, only conditionally disclosed ordering change.

## Warnings

### WR-01: `RecordsScaffoldPins.test.ts` is a permanent cross-package source scan that cannot enforce the adoption and will break on legitimate refactors

**File:** `packages/sql/test/RecordsScaffoldPins.test.ts:21-23, 368-424, 426-444, 484-485, 513-514`
**Issue:** This is a Wave 0 phase oracle left in the permanent suite of `@awthaq/sql`, and it has three problems.
1. **Cross-package coupling.** It reads 20 files in 8 other packages plus `examples/plugin-template` by relative path, and pins `Ref.make` / `Semaphore.make` counts, lock-key template literals, and magic totals (`16`, `176`, `9`, `11`).
   - Scenario: a plugin author adds a second `Ref` to a `layerMemory`, or a lock key gains a segment. That has no behavioural meaning for the record contract, yet a test in a different package (`@awthaq/sql`) goes red and the failure names none of the files being edited. Splitting a store module, or moving the lock keys of `two-factor` and `qadi`, breaks it too.
2. **It cannot enforce the adoption.** `TODAY` (the old closure) and `ADOPTED` are both accepted, and the first test case asserts both are accepted. A future edit that reverts a module to the hand-written closure passes. The "frozen at 3be32564" claim is true, but the test no longer guards the scaffolding it was written to protect.
3. **The `Ref`/`Semaphore` counts are only a proxy.** `ImpersonationRecords` keeping "2 Refs and 1 Semaphore" says nothing about atomicity. The race and atomic contract cases already do that. The phase's `Ref` freeze is therefore tested twice, once meaningfully and once as text.

**Fix:** After the phase gate, either delete the file, or cut it to the part that guards something that still exists:
```ts
// keep: labels per store, ADOPTED only (drop TODAY and the "accepts both" case)
const ADOPTED = /const (unavailable|failing) = StoreFailure\.labelled\("(\w+)"\);/g;
// drop: STATE (Ref/Semaphore counts) and the hard-coded totals 16/176/9/11
```
Per-store label ownership is then a property tied to the module, not to a frozen count. If the file stays as a historical oracle, move it out of `packages/sql/test` into the phase's scripts.

### WR-02: Five adopted sites change `localeCompare` to code-unit comparison, which no pin can detect, and the changeset reads as "unchanged"

**File:** `packages/organization/src/ConnectionRecords.ts:339-345`, `packages/saml/src/SamlRecords.ts:265-283`, `packages/scim/src/ScimRecords.ts:174-183`, `packages/webhooks/src/WebhookRecords.ts:314-322`, `packages/organization/src/TeamRecords.ts:364-371`; `.changeset/record-store-helpers.md:15`
**Issue:** The removed comparators at these 5 modules (6 `chronological` sites) used `a.id.localeCompare(b.id)`. `Keyset.chronological` orders ids with `Order.String`, a code-unit `<`. The two differ for mixed-case or punctuated ids. `Keyset.test.ts:48` states this itself: "a locale order would put `_x` and `a1` before `B1`".
- Every Wave 0 pin (`RecordOrderPins` x4) uses lowercase uuidv7 ids (`...0001` to `...0009`) on which both orders agree. So the one intentional semantic change of the phase is, by construction, invisible to the pins that were meant to prove behaviour preservation. They would pass with either implementation.
- The stores mint lowercase uuidv7 (`SamlConnections.ts:355`, `ScimConnections.ts:94`, `Webhooks.ts:602`). But `SamlRecords.create`, `ConnectionRecords.create`, `ScimRecords.createConnection` and `WebhookRecords.createEndpoint` take a caller-supplied `id`. A third-party caller or plugin that supplies `"Zed"` and `"apple"` on equal `createdAt` now gets a different memory order.
- The change does bring memory closer to SQLite and `COLLATE "C"`, which the SQL `ORDER BY id` implies. It moves away from a Postgres database with a locale collation, where `localeCompare` was the nearer twin.
- The changeset says every listing order "(for the canonical ids the stores mint) ... is unchanged". That qualifier is correct, but it is the only place the change is admitted. `WebhookRecords` now mixes both orders in one module: code unit at `:317`, `localeCompare` still at `:559` and `:798`.

**Fix:** Pin the delta so it is a decision and not an accident. Add one case to a `RecordOrderPins` file (memory and SQL) with ids that differ under the two orders (`"B1"`, `"_x"`, `"a1"` on equal `createdAt`), expecting the code-unit order on both adapters. State in the changeset that the memory twin of these 5 listings now sorts caller-supplied ids by code unit rather than by locale. Align or document the two remaining `localeCompare` sites in `WebhookRecords`.

## Info

### IN-01: Order pins have no recorded mutation check for tie-break sensitivity on the memory adapter

**File:** `packages/organization/test/RecordOrderPins.test.ts:50-67`, `packages/saml/test/RecordOrderPins.test.ts:63-78`, `packages/scim/test/RecordOrderPins.test.ts:40-57`, `packages/webhooks/test/RecordOrderPins.test.ts:65-84`
**Issue:** Each case ties C, A, B on `createdAt` (inserted in that order) behind an earlier X. On the memory adapter the rows live in a `HashMap`, so the pre-sort order is hash order, not insertion order. A mutant that drops the id tie-break survives only if the hash iteration order of `{A,B,C}` happens to equal `[A,B,C]`. 06-BASELINE records a mutation check for the label test only. The "time first" half is sound, since X has the largest id and the earliest time. The "then id" half is unproven.
**Fix:** Run one throwaway mutation (drop the id key from `Keyset.chronological`) against the four pin files and record it, or add a third tied row so that two of the six permutations are not accidentally correct.

### IN-02: Changeset says the records modules use both helpers, but only 11 of 16 use `chronological` and F1/F2 keep hand-written comparators

**File:** `.changeset/record-store-helpers.md:15`
**Issue:** "the plugin records modules now use both" is imprecise. All 16 use `labelled`, 9 modules use `chronological`, and `DeviceGrantRecords` and `SigningKeyRecords` still carry their own `createdAt` comparators (open F1/F2, not re-reported). Anyone reading the changelog will assume the comparator scaffolding is complete.
**Fix:** "the plugin records modules now use `StoreFailure.labelled`, and the listings that tie-break on `id` use `Keyset.chronological`".

### IN-03: `Keyset.chronological` adds code at every call site and sits in a keyset-page module

**File:** `packages/ports/src/Keyset.ts:127-138`, call sites such as `packages/api-key/src/ApiKeyRecords.ts:98-105`
**Issue:** Per 06-BASELINE the comparator adoption nets +58 lines (removed 45, added 103). Each call site grows from a 3-line comparator to a 6-line object, and the first accessor needs an explicit `(row: T) =>` annotation so that `id` can infer its `Row`. The helper passed the spike only through the "divergent copies" branch. Placing a sort comparator for record listings in `Keyset.ts`, whose header describes the KEY-01 page contract (`paginate`, `window`, `KeysetSql`), is a cohesion stretch: `chronological` has no cursor, column or SQL twin.
**Fix:** No change required. If call sites are touched again, consider a positional form `chronological(createdAt, id, direction)` to drop the annotation, or move the helper beside `Order` helpers in `@awthaq/ports`.

### IN-04: F-06-01 fix still rests on a database-global latch key and a doc grammar slip in the spec row

**File:** `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts:122-123, 156, 344`; `spec/traceability.md` (the `StoreFailure.test.ts` row)
**Issue:** (a) `LATCH_KEY = 4_040_404` is a fixed advisory key shared by every database user, while the waiter is now scoped to a key. Two concurrent runs of this file against one database (for example two CI shards on a shared Postgres, the case the baseline names) block each other's latch trigger. Counting would be correct then, but the race case would hang or be released by the wrong run. The fix removed the cross-file miscount, not the cross-run collision. (b) The traceability row reads "...retries only retryable reasons, and `labelled(store)` names..." with a stray extra "and" in a list.
**Fix:** Derive the latch key per test run, for example `hashtextextended('latch:' || schema, 0)`, or document the single-runner assumption next to `LATCH_KEY`. Reword the traceability row: "..., and `labelled(store)` names the operation `<store>.<operation>`".

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
