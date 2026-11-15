---
phase: 06-record-store-scaffolding
verified: 2026-11-14T20:00:00Z
status: passed
score: 5/5 roadmap truths verified in code (SC4 on its no-edit branch; the three human items were accepted by the user on 2026-11-15); 0 failed; Postgres legs run locally on Debian postgres:16, CI confirmation open (no git remote)
covered_files:
  - .changeset/record-store-helpers.md
  - .planning/phases/06-record-store-scaffolding/06-01-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-01-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-02-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-02-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-03-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-03-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-04-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-04-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-05-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-05-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-06-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-06-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-07-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-07-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-08-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-08-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-09-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-09-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-10-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-10-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-11-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-11-SUMMARY.md
  - .planning/phases/06-record-store-scaffolding/06-12-PLAN.md
  - .planning/phases/06-record-store-scaffolding/06-12-SUMMARY.md
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
covered_digest: "v4:sha256:7e061b956c3611c900ca3d3f1a611166349bd1971fca2b0f99fc03f7b35a019f"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Confirm the WR-02 ordering change for non-canonical ids"
    expected: "The memory twins of the organization connection, team, SAML, SCIM and webhook endpoint listings now order ids by code unit instead of locale; accept it (the changeset discloses it) or ask for the five sites to go back to localeCompare"
    why_human: "Whether a caller-supplied mixed-case or punctuated id is a legal input is a product judgement. The fixer marked WR-02 'requires human verification'; the orchestrator accepted it, the user has not."
  - test: "Decide whether docs/plugin-authoring.md and examples/plugin-template/ should name StoreFailure.labelled"
    expected: "Either accept 06-11's no-edit branch (both still correct, tests pass) or have line 29 of the guide and Template.ts:266,273 adopt labelled(store) so the template matches the 16 in-repo records modules"
    why_human: "SC4 says the docs are 'updated last'. Plan 06-11 took a no-edit branch because nothing in them is wrong. Whether that satisfies the criterion's intent is an editorial call."
  - test: "Veto check on REC-01"
    expected: "The user accepts that Track A is closed by an argument and the approved requirement, not by a run spike, and that ADR-EA-046 is released rather than written"
    why_human: "06-CONTEXT.md says the closure is a docs-only, reversible record the user can veto at the final report."
---

# Phase 6: Record-store scaffolding (gated) Verification Report

**Phase Goal:** The repeated record-store scaffolding is consolidated only if a spike proves enough files share a helper; otherwise the candidate is closed with a recorded no-go.
**Verified:** 2026-11-14
**Status:** human_needed (no failed truth, no gap; three judgement items remain that code cannot settle). Verified at HEAD `fe2a637e`, which includes the review fixes WR-01, WR-02 and IN-01..IN-04.
**Re-verification:** No, initial verification

## Goal Achievement

The spike ran, measured and returned go, so the go branch applies: SC5 (no-go) is not applicable and is verified as such. Exactly the two helpers that passed were scaffolded and nothing else.

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Before scaffolding code, an ADR-EA-041 revision note records plan 24 Track A closed and ADR-EA-046's fate is decided in `spec/decisions/` | VERIFIED | `spec/decisions/041-domain-store-ports.md` Revision 1.7 (Effective Date and Change History bumped together) carries a "Revision note (1.7)" under Consequences and alternative (e), closing Track A and stating that ADR-EA-046 "is released". No `046-*.md` exists in `spec/decisions/` and `index.yaml` has no 046 row, so no number is left reserved and unexplained. `.planning/README.md:206` marks 046 released. Order: `git log --reverse` on `spec/decisions/041...`, `packages/ports/src`, `packages/sql/src` shows `c9a629ca` (ADR) before `4083d617` (`StoreFailure.labelled`) and `54e0d09a` (`Keyset.chronological`). The note is honest that the Track A spike was never run and the closure rests on the argument and the approved REC-01 requirement (human item 3). |
| 2 | A spike on the four files yields a written go/no-go; no-go if fewer than about 5 files share a helper | VERIFIED | `06-SPIKE.md` quotes the CONTEXT rule (per helper: (a) about 5 of 16 files, (b) deletion test, (c) behaviour-preserving), fixed in `77515195` before measurement. It censuses all 16 `*Records` files, not just the four named, and records per helper: comparators 9 files pass; unavailable-label 16 pass; tenant-visibility 2 fail (a); wire-row 14 fail (b); sqlstore-make 16 fail (b). Ends `SPIKE-VERDICT: go`, `SPIKE-PASSED: comparators, unavailable-label`, three `SPIKE-NOT-PURSUED` lines carrying their numbers. The verdict is mechanical, not fitted: the margins (comparators passes (b) only by the divergent-copies branch, net -59 lines; unavailable-label by net +1) are stated and not adjusted. Findings F1 (`DeviceGrantRecords.listByUser` memory has no id tie-break) and F2 are recorded and left alone. |
| 3 | On go: the passed scaffolding replaces the repeated copies with no `*Shape` change; `RecordsContract` verdicts unchanged; `Ref` counts, lock keys, operation labels byte-identical | VERIFIED | See the detail below. Scaffolding in code: `StoreFailure.labelled` (`packages/sql/src/StoreFailure.ts`, one doc line, `(store) => typeof orStoreUnavailable`) adopted by 16 of 16 modules; `Keyset.chronological` (`packages/ports/src/Keyset.ts`) adopted at 11 sites in 9 modules. `tsc -b` exit 0 and `shasum -a 256 -c 06-SHAPE-DTS.sha256` prints 16 OK, 0 other (no `*Shape`, layer or record type moved). `git diff --name-only 3be32564 HEAD` over `packages/test/src/RecordsContract.ts` and every `test/contract/` path is empty. Pieces for tenant-visibility, wire-row and `SqlStore.make` are closed as not pursued with the spike's numbers (REC-03 reads "on go ... replace", and the CONTEXT rule says only helpers that pass are scaffolded). |
| 4 | On go, `docs/plugin-authoring.md` and `examples/plugin-template/` are updated last and their tests pass; Postgres legs run locally on Debian `postgres:16`, recorded "CI confirmation open (no git remote)" | VERIFIED on its no-edit branch; UNCERTAIN on intent (human item 2) | Neither file changed (`git diff 3be32564 HEAD -- docs examples` empty). `06-BASELINE.md` "06-11" records the check: line 29 of the guide and `Template.ts:266,273` pipe literal `orStoreUnavailable("<Records>.<method>")`, which `labelled` leaves correct, so the edit condition was not met. They are still "last" in the sense that spec rows and the changeset come after every `packages/*/src` commit (awk order check `bad=0`). `npx vitest run examples/plugin-template`: 3 files, 55 passed (re-run here). Postgres: container `awthaq-p3-pg` (Debian `postgres:16`) was up and I re-ran the phase files plus `OrganizationConnectionLifecycle.sql.test.ts` with `AWTHAQ_POSTGRES_URL` set: 8 files, 68 passed; the full-suite Postgres record at close is in the baseline ("run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)"). |
| 5 | On no-go, REC-03/REC-04 recorded not pursued; no scaffolding lands | VERIFIED (not applicable) | The verdict is go. The not-pursued helpers (not the whole of REC-03) are recorded with their reasons in `06-SPIKE.md` and "REC-03 closure" in the baseline, and none of their names appears in any changed path. |

#### Detail for SC3: the REC-04 invariants checked in code, not from the SUMMARYs

| Invariant | How checked at HEAD | Result |
|-----------|---------------------|--------|
| Operation labels byte-identical | `git diff 3be32564 HEAD -U0 -- packages \| grep -E 'unavailable\(\|failing\('` over added/removed lines: the only hits are in test files. No `unavailable("...")` or `failing("...")` call-site line changed. The only src lines touched are the 16 closure definitions, each `orStoreUnavailable(\`<Store>.${operation}\`)` becoming `StoreFailure.labelled("<Store>")`, which builds the same string; the store literal is the module's own name in all 16. | VERIFIED |
| Lock-key strings byte-identical | The same diff, grepped for `atomically`, `SqlStore`, `lock`: no src line. The 11 `SqlStore.atomically` keys (9 files) are untouched. The one lock edit is test-only (`OrganizationConnectionLifecycle.sql.test.ts`, the F-06-01 fix and IN-04 per-run latch key). | VERIFIED |
| Every `layerMemory` keeps its `Ref` count; `ImpersonationRecords` keeps two `Ref`s and a `Semaphore` | The same diff, grepped for `Ref.make` and `Semaphore`: no src line. `ImpersonationRecords.ts` changed by one closure line only (`3 +-`). Counts are the spike's table: 15 modules at 1, `ImpersonationRecords` at 2 plus one `Semaphore.make(1)`. The REC-04 wording "one `Ref` each" is corrected in the record (CONTEXT, spike, baseline), not by rewriting a module. | VERIFIED |
| Listing order for canonical ids | 11 comparator sites each pinned on memory and SQL: 4 contract cases that already tie on `createdAt`, plus `RecordOrderPins.test.ts` in organization, saml, scim and webhooks (22 tests). Written green on untouched `src` (one add commit each: `3b75b1ea`, `726235f8`). IN-01 mutation (id key replaced by a constant in `chronological`): 11 of 11 memory cases fail, 11 of 11 SQL cases pass, so no case survives by hash-order luck. Re-run here: SQLite 7 files, 65 passed; Postgres 8 files, 68 passed. | VERIFIED |
| The one deliberate semantic delta | Five sites (Connection, Team `:364`, Saml, Scim, Webhook endpoints) compared ids with `localeCompare` and now use code unit. Identical for canonical lowercase uuidv7 ids (spike: 0 of 20000 pairs differ); it differs only for caller-supplied mixed-case or punctuated ids on equal `createdAt`. Disclosed in the changeset (WR-02 fix `dfa6383b`); two remaining `localeCompare` sites in `WebhookRecords` carry a `shortcut:` comment. This is outside "byte-identical for canonical inputs" by the CONTEXT rule's own wording, but it is a real memory-twin change, hence human item 1. | VERIFIED within the rule; human call requested |

**Score:** 5/5 truths verified in code. 0 behavior-unverified (every behaviour-dependent truth, the listing order and the label and lock invariants, has a passing behavioural test or a no-line-changed diff).

### WR-01 and the oracle-integrity claim (the question put to this verification)

Commit `7f711b0b` rewrote `packages/sql/test/RecordsScaffoldPins.test.ts` after 06-12 closed the phase. The pin was 4 cases (a source scan with the `TODAY`/`ADOPTED` spellings, 16-module label tables totalling 176 strings, `Ref.make`/`Semaphore.make` counts, 11 lock-key literals). It is now 1 finder case plus one case per glob-discovered `*Records.ts` (17 tests): exactly one `const (unavailable|failing) = StoreFailure.labelled("<file name>")` and no `orStoreUnavailable(` in the file.

**Does REC-04 still hold, and is it still adequately protected?**

- **REC-04 itself holds at HEAD.** That was shown above from the diff, which is stronger evidence than a pin: no `unavailable(...)` call line, `atomically` line, `Ref.make` or `Semaphore` line changed in any `packages/*/src` file since the phase base. The deleted pin did its job at phase close (it was green on untouched `src` and stayed green across the adoption, and the baseline records its mutation check). It was a transition oracle, and the transition is done.
- **Residual protection after WR-01, by invariant:**
  - Store-name label: stronger than before. The glob form fails a module that reverts to a closure, takes another module's name, or is new and unlabelled; the old form accepted both spellings and could not catch a revert. The review's revert check (SamlRecords closure restored: 16 passed, 1 failed) shows it bites. `StoreFailure.test.ts` pins what `labelled("Probe")("read")` builds (`Probe.read`), and 7 of 16 contract files assert one operation label each.
  - Operation names (the 176 literals): no longer byte-pinned; a future rename or typo of one operation label would pass. Acceptable. They are `<store>.<operation>` strings in a diagnostic channel, the removed table was a change detector for every added method, and the phase invariant (unchanged today) is shown by the diff.
  - `Ref`/`Semaphore` counts: no longer pinned as text. The behaviour they stand for (atomic create, race, interrupted create leaves row and link together) is exercised by the `RecordsContract` atomic and race cases, which is the meaningful guard; the review (WR-01.3) is right that the count is a proxy.
  - Lock keys: no longer pinned byte for byte; a key edited consistently would not trip anything. It would also not change behaviour, and the race and F-06-01 cases still exercise the lock. Accepted trade-off.
- **Verdict:** adequately protected for the invariants that carry behaviour; the only thing given up is a frozen-text change detector for operation names, lock-key spelling and `Ref` counts. I do not count it as a gap.
- **The baseline note is now stale and should be amended.** Append (do not rewrite history) an "Amendments > Post-review WR-01" entry to `06-BASELINE.md` saying: (1) "Wave 0 oracle integrity" ("each file appears in exactly one commit ... none edited after its add commit") is true for the four `RecordOrderPins.test.ts` files only; `RecordsScaffoldPins.test.ts` now appears in two commits (`e47f02e2`, `7f711b0b`) and its cases 2 to 4 (labels table, `Ref`/`Semaphore` counts, lock keys) were deleted; (2) the "REC-04 closure" sentence "the five Wave 0 pin files ... are unedited since their add commits" should read "four of the five"; (3) the 06-05 line "never edited afterwards" and the phase-close counts ("RecordsScaffoldPins 4", 28 new tests, 6727 unit tests) are now 17 and 41 and 6740 respectively on SQLite; (4) REC-04's byte-identity at close was established with the original pin and is, at HEAD, shown by the empty diff of those lines (the grep above). `06-12-SUMMARY.md` and `06-VALIDATION.md` repeat the "65/65" and four-case figures; `06-VALIDATION.md` already lists 7 files / 65 tests, which matches HEAD.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/sql/src/StoreFailure.ts` `labelled` | one exported helper | VERIFIED | `labelled(store): typeof orStoreUnavailable`, wired from 16 modules; test case in `StoreFailure.test.ts` |
| `packages/ports/src/Keyset.ts` `chronological` | one exported helper | VERIFIED | `{ createdAt, id, direction }`, code-unit id order, `desc` is the flip; wired from 9 modules (11 sites); test case in `Keyset.test.ts`; `ports` gains only an `effect/DateTime` import |
| 16 `*Records.ts` adopters | closure replaced | VERIFIED | 16 `StoreFailure.labelled("<own name>")`, 0 `orStoreUnavailable(` closures |
| `RecordOrderPins.test.ts` x4 | Wave 0 order pins | VERIFIED | 22 tests, memory and SQL, one add commit each, inline-literal expectations |
| `RecordsScaffoldPins.test.ts` | label-rule guard | VERIFIED (rewritten by WR-01, see above) | 17 tests |
| `spec/decisions/041-...md` rev 1.7, `spec/overview.md`, `spec/traceability.md` | revision note, rows | VERIFIED | `pnpm spec:verify:strict` PASS 32, FAIL 0, SKIP 0 |
| `.changeset/record-store-helpers.md` | one changeset, `Migration:` | VERIFIED | ports and sql minor, eight adopting packages patch; `Migration: none required`; discloses the WR-02 ordering delta |
| `06-SHAPE-DTS.sha256` | 16 declaration hashes | VERIFIED | 16 OK after `tsc -b` |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| 16 records modules | `StoreFailure.labelled` | `const unavailable = StoreFailure.labelled("<Store>")` (`failing` in `WebhookRecords`) | WIRED |
| 9 records modules (11 sites) | `Keyset.chronological` | import from `@awthaq/ports`; `device-authorization` and `organization` already declare the dependency | WIRED |
| `@awthaq/ports` | new package edges | none: `git diff --stat 3be32564 HEAD -- 'packages/*/package.json' pnpm-lock.yaml` empty, `pnpm circular` no findings | UNCHANGED |
| contract verdicts | `RecordsContract` and per-package `test/contract/` | zero changed paths | UNCHANGED |

### Data-Flow Trace (Level 4)

Not applicable beyond the order and label paths: `chronological` is a pure `Order` over the rows' real `createdAt` and id; `labelled` builds the failure's `operation` string, asserted by `StoreFailure.test.ts` and by the contract cases that read `StoreUnavailable.operation`. No hardcoded or hollow data.

### Behavioral Spot-Checks and Gates (run in this verification)

| Check | Command | Result |
|-------|---------|--------|
| Build | `npx tsc -b tsconfig.json` | exit 0, no output |
| Declarations | `shasum -a 256 -c .planning/phases/06-record-store-scaffolding/06-SHAPE-DTS.sha256` | 16 OK, 0 other |
| Phase tests, SQLite | `npx vitest run` over the 7 phase files (`RecordsScaffoldPins`, four `RecordOrderPins`, `StoreFailure`, `Keyset`) | 7 files, 65 passed |
| Phase tests, Postgres | the same 7 plus `OrganizationConnectionLifecycle.sql.test.ts`, `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq`, container `awthaq-p3-pg` (postgres:16) | 8 files, 68 passed. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote) |
| Template | `npx vitest run examples/plugin-template` | 3 files, 55 passed |
| Spec | `pnpm spec:verify:strict` | PASS 32, FAIL 0, SKIP 0 |
| Cycles | `pnpm circular` | no findings |
| Dependencies | `git diff --stat 3be32564 HEAD -- 'packages/*/package.json' pnpm-lock.yaml features/package.json` | empty |
| Scope | `git diff --name-only 3be32564 HEAD \| grep -v '^\.planning/'` | 30 paths, all in the baseline's allowlist (src, tests, spec, changeset); none under `docs/`, `examples/` or `test/contract/` |
| Tree | `git status --porcelain -- packages spec docs examples .changeset` | clean |

The full unit, bdd, coverage, knip and `package:smoke` suites were not re-run here; their phase-close records are in `06-BASELINE.md` "Phase close" (unit 6727 passed on SQLite, 6770 on Postgres, coverage 91.81 / 85.31 / 87.13 / 92.33, knip equal to baseline) and the review fixes after that were re-run by the fixer over `packages/{sql,ports,organization,saml,scim,webhooks}` (137 files passed) plus lint, format, circular and spec.

### Probe Execution

No probe scripts declared for this phase: SKIPPED.

### Requirements Coverage

| Requirement | Verdict | Evidence |
|-------------|---------|----------|
| REC-01 | SATISFIED (veto open, human item 3) | ADR-EA-041 rev 1.7 note and alternative (e); ADR-EA-046 released; both before any scaffolding commit |
| REC-02 | SATISFIED | `06-SPIKE.md`: written, measured go/no-go with the rule committed first; the four named files are in its table, plus the 16-file census |
| REC-03 | SATISFIED for the passed helpers | comparators and `unavailable(op)` labelling replaced the repeated copies, no `*Shape` change, contract verdict files untouched. Tenant-visibility, wire row and `SqlStore.make` closed as not pursued with numbers, as the go rule requires |
| REC-04 | SATISFIED | `Ref`, `Semaphore`, lock-key and call-site label lines untouched (diff), 16 declaration hashes equal, `ImpersonationRecords` keeps two `Ref`s and a `Semaphore`, the REC-04 wording corrected in the record. Docs on the no-edit branch (human item 2) |
| GATE-04 | SATISFIED | Postgres legs run on Debian postgres:16, recorded "CI confirmation open (no git remote)"; failing-test list empty at close |

No orphaned requirements: REQUIREMENTS.md maps REC-01..04 to Phase 6 and the plans claim them. Checkbox state and the ROADMAP progress row (still "In Progress") are for the orchestrator to update; this report changes neither.

### Anti-Patterns Found

None blocking. No `TBD|FIXME|XXX|TODO|HACK` added (the two `shortcut:` comments in `WebhookRecords.ts` name their limit and when to align). `no as` was added in `packages/*/src`. Open, recorded, not fixed here and not gaps:

- F1 (`DeviceGrantRecords.listByUser` memory has no id tie-break, SQL orders by `createdAt, id`) and F2 (`SigningKeyRecords` no tie-break either side): behaviour-preserving phase, left alone by decision.
- F-06-03: the admin `ImpersonationRecords (sql)` contract pair can time out at 5 s in a full-suite Postgres run (never alone); known-intermittent 3, did not fire at close.
- IN-03 (`chronological` sits in a keyset module and adds call-site weight) skipped by decision; the spike says it passes (b) only through divergent copies and the phase reports net -58 lines for it and net -2 for `labelled`. The phase is justified by locality and the single rule, not size, and the baseline says so.

Review: `06-REVIEW.md` 0 critical, 2 warning, 4 info; dispositions in `06-REVIEW-DISPOSITION.md` (WR-01, WR-02, IN-02, IN-04 fixed; IN-01 checked; IN-03 skipped). `06-SECURITY.md` `threats_open: 0`, `status: verified`. `06-VALIDATION.md` `status: validated`.

### Human Verification Required

1. **WR-02: memory-twin id order for non-canonical ids.**
   **Test:** Decide whether a caller-supplied mixed-case or punctuated id on equal `createdAt` may list in code-unit order in the memory twin of five listings (it matches SQLite's `ORDER BY id`, `Keyset`, and BEH-EA-036's canonical-id guarantee; it no longer matches the old `localeCompare`).
   **Expected:** Accept (disclosed in the changeset), or restore `localeCompare` at the five sites.
   **Why human:** Which ids are legal inputs is a product call; the orchestrator accepted it, the user has not.
2. **SC4 docs.**
   **Test:** Read `docs/plugin-authoring.md:29` and `examples/plugin-template/src/Template.ts:266,273` against the 16 in-repo modules that now use `StoreFailure.labelled`.
   **Expected:** Accept the no-edit branch, or add `labelled(store)` to the template and one sentence to the guide, with the template contract test (`examples/plugin-template`, 55 tests) and `check:readmes` re-run.
   **Why human:** Editorial: the docs are correct, but SC4 says "updated".
3. **REC-01 veto.**
   **Test:** Confirm Track A's closure and the release of ADR-EA-046 as recorded in ADR-EA-041 rev 1.7.
   **Expected:** Accept; it is a docs-only, reversible record.
   **Why human:** CONTEXT reserves it for the user at the final report.

### Gaps Summary

No gaps. Every roadmap criterion holds in the code at HEAD `fe2a637e`: the ADR record precedes the scaffolding, the spike's go is measured under a rule fixed beforehand, exactly the two passing helpers were scaffolded, and the REC-04 invariants (labels, lock keys, `Ref`/`Semaphore`, declarations, contract verdicts) are unchanged by diff, not just by the summaries. `human_needed` is for the three judgement calls above and for the documentation amendment to `06-BASELINE.md` after WR-01 (a note, not a code gap).

---

_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
