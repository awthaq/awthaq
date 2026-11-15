---
phase: 06-record-store-scaffolding
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/06-record-store-scaffolding/06-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 5
skipped: 1
status: partial
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-11-14
**Source review:** `.planning/phases/06-record-store-scaffolding/06-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (WR-01, WR-02, IN-01 to IN-04)
- Fixed: 5 (4 commits for WR-01, WR-02, IN-02, IN-04; IN-01 is a recorded mutation check with no file change)
- Skipped: 1 (IN-03, by the review's own "no change required")

Verification ran in the main checkout (`use_worktrees` is false; no temporary worktree). Locked rules held: no `COLLATE "C"`, cursor wire untouched, no `*Shape` change (`06-SHAPE-DTS.sha256`: 16 of 16 OK after `npx tsc -b tsconfig.json`), no `as` in `packages/*/src`.

## Fixed Issues

### WR-01: `RecordsScaffoldPins.test.ts` was a cross-package scan that could not enforce the adoption

**Files modified:** `packages/sql/test/RecordsScaffoldPins.test.ts`
**Commit:** `7f711b0b`
**Applied fix:** Option chosen: cut the file to the one rule that still guards something, and make it discover its subjects instead of listing them. It now globs `packages/*/src/*Records.ts` and, per module, asserts exactly one `const (unavailable|failing) = StoreFailure.labelled("<ModuleName>")` (the argument must equal the file name) and no `orStoreUnavailable(` anywhere in the file. Deleted: the `TODAY` spelling and the "accepts both" case, the 16-module operation-label tables and the 16/176/9/11 totals, the `Ref.make` / `Semaphore.make` counts, and the lock-key literals.

Why this option and not the others:
- Deleting the file would drop the only guard that a module stays on `labelled`. Moving it to a phase script would leave the guard out of `pnpm test`.
- The label rule is the one property the adoption created, so that is what stays. Operation names (`<store>.<operation>`) are `StoreFailure.test.ts`'s case; a frozen list of 176 of them is a change detector for every added method.
- The `Ref`/`Semaphore` counts duplicated the race and atomic contract cases as text, and the lock keys are literals owned by their modules and exercised by the F-06-01 and atomic cases.
- Discovery by glob means a new `*Records.ts` is held to the rule with no edit and no total to bump. The cross-package read stays (that is what enforcing "every records module" means), but the failure message now names the file and the expectation.

Revert check (recorded): temporarily restoring the old closure in `SamlRecords.ts` failed exactly that module's case (`16 passed, 1 failed`); `git checkout` restored it and `git status` was clean.

### WR-02: five sites moved from `localeCompare` to code-unit id order

**Files modified:** `.changeset/record-store-helpers.md`, `packages/webhooks/src/WebhookRecords.ts`
**Commit:** `dfa6383b`
**Status:** fixed: requires human verification (a judgement about which ids are legal)

Conclusion (no behaviour restored, no new behaviour pin):
- **Type and validation.** Every records API types `id` as a plain `string` with no validation (`ConnectionRecords.create`, `SamlRecords.create`, `ScimRecords.createConnection`, `WebhookRecords.createEndpoint`), so a mixed-case id is type-legal. The divergence is real only there.
- **Who supplies ids.** Every in-repo caller mints lowercase uuidv7: `OrganizationConnections.ts:433`, `SamlConnections.ts:355`, `ScimConnections.ts:94`, `Webhooks.ts:602`, `WebhookDelivery.ts:119`; `TeamRecords` mints its own (`:302`, `:1022`) so Team has no caller-supplied id at all; the SCIM link tie-breaks (`resourceId`, `connectionId`) are ids minted by core and organization. For these, `localeCompare` and code unit agree (06-SPIKE: 0 of 20000 differ).
- **Why not restore `localeCompare`.** BEH-EA-036 already states the contract: canonical lowercase uuidv7 ids order alike under code unit and any collation, and "other ids ... their exact order may follow the database collation". SQLite's `ORDER BY id` is binary (code unit), Postgres follows the database collation, and `localeCompare` matched neither exactly. Code unit is the order `Keyset` declares and `Keyset.test.ts:48` pins. Restoring the old comparator at five sites would split the helper again to preserve an order nothing specifies.
- **Why no pin.** The review suggested a mixed-case case in the four `RecordOrderPins` files on both adapters. That would pin unspecified behaviour and would be red on Postgres under a locale collation (`COLLATE "C"` is locked out), so none was added. The helper's code-unit order for mixed-case, tied rows is already pinned in `packages/ports/test/Keyset.test.ts`.
- **What changed instead.** The changeset now says it: the memory twins of the organization connection, team, SAML, SCIM and webhook endpoint listings compared ids by locale and now compare by code unit, so a caller-supplied non-canonical id on equal `createdAt` can list in a different order.
- **`WebhookRecords` consistency.** The two remaining `localeCompare` sites (`claimDue` tie-break, `listDeliveries` descending sort; the latter filters by code unit with `row.id < before` and then sorts by locale) cannot be aligned without a behaviour change for non-canonical ids, which the rule for this fix forbids. Each now carries a one-line `shortcut:` comment naming the limit and when to align. Left to the human: aligning them is the same class of change as the five already adopted and is a one-line edit each if wanted.

### IN-01: no recorded mutation check for the memory tie-break

**Files modified:** none
**Commit:** none (a check, not a change)
**Applied fix:** Mutation: in `Keyset.chronological` the id key was replaced by a constant (`Order.mapInput(Order.String, () => "")`), then `npx tsc -b tsconfig.json` (the packages resolve `@awthaq/ports` through `lib/`, so the mutation is invisible until rebuilt: the first run before the rebuild passed 22 of 22 and proves nothing), then the four `RecordOrderPins.test.ts` files.

| Package | Memory cases failed under the mutant |
|---|---|
| organization | 3 (`ConnectionRecords.listByOrganization`, `TeamRecords.getDescendants`, `TeamRecords.getSubtree`) |
| saml | 2 (`listByOrganization`, `listSpKeys`) |
| scim | 3 (`listConnections`, `list`, `linksOfResource`) |
| webhooks | 3 (`listEndpoints`, `listEnabledEndpoints`, `listBySubject`) |

All 11 memory cases failed, all 11 SQL cases passed (the SQL `ORDER BY` is not touched by the mutant), so no memory case survives by hash-order luck and no third tied row is needed. Reverted with `git checkout -- packages/ports/src/Keyset.ts`, rebuilt, `git diff --stat -- packages` empty, 22 of 22 green again.

### IN-02: changeset wording

**Files modified:** `.changeset/record-store-helpers.md`
**Commit:** `3c9769be`
**Applied fix:** "the plugin records modules now use both" became "the plugin records modules now use `StoreFailure.labelled`, and the listings that tie-break on an id use `Keyset.chronological`", so it no longer implies the F1/F2 comparators are covered.

### IN-04: latch key and traceability grammar

**Files modified:** `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts`, `spec/traceability.md`
**Commit:** `189a5158`
**Applied fix:** `LATCH_KEY` is now `randomInt(1, 2 ** 31)` from `node:crypto`, drawn per run, so two runs on one database never share it; the range is positive and below 2^31 so the waiter's `classid`/`objid` split is unchanged. The `StoreFailure.test.ts` row lost its stray "and" ("..., a `SchemaError` die, `retryTransient` retries only retryable reasons, and `labelled(store)` names ..."). Revision stays 1.95: the row sits inside the existing 1.95 entry for this phase, and `pnpm spec:verify:strict` passes 32 of 32 (check 14 included).
Postgres leg (fresh `postgres:16` container via `pg-fresh.sh`, `AWTHAQ_POSTGRES_URL` explicit): `OrganizationConnectionLifecycle.sql.test.ts` 3 passed, none skipped.

## Skipped Issues

### IN-03: `Keyset.chronological` placement and call-site weight

**File:** `packages/ports/src/Keyset.ts:127-138`
**Reason:** decision, no change. The review says no change is required, and moving the helper or changing its signature would touch all 9 adopted modules and the published `@awthaq/ports` surface for a cohesion point, against the behaviour-preserving rule and with the `.d.ts` hashes pinned. Revisit (positional `chronological(createdAt, id, direction)` or a sibling order module) the next time those call sites are edited.
**Original issue:** The helper adds code at each call site and sits in a keyset-page module although it has no cursor, column or SQL twin.

## Verification (final tree, main checkout)

- `npx tsc -b tsconfig.json` clean; `06-SHAPE-DTS.sha256` 16 of 16 OK.
- `npx vitest run packages/sql packages/ports packages/organization packages/saml packages/scim packages/webhooks` on SQLite: 137 files passed, 5 skipped (Postgres-only); 2427 tests passed, 21 skipped.
- `pnpm lint` exit 0 (the only warnings are in the untracked `.claude/` tree), `pnpm format:check` clean, `pnpm circular` exit 0, `pnpm spec:verify:strict` 32 pass / 0 fail.
- `pnpm knip` outside `.claude/`: the 3 `readme-quickstart.ts` unlisted-dependency rows only, equal to baseline (its 39 unused-file rows are all under the untracked `.claude/`).
- No path outside the 06-BASELINE allowlist was touched, so no allowlist line was appended.

---

_Fixed: 2026-11-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
