---
phase: "06"
slug: "record-store-scaffolding"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-14"
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `06-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest with `@effect/vitest`; Cucumber BDD (`pnpm test:bdd`) |
| **Config file** | root `vitest.config.ts` (`projects`); no new config |
| **Quick run command** | `npx tsc -b tsconfig.json && npx vitest run packages/ports/test/Keyset.test.ts packages/sql/test/StoreFailure.test.ts packages/sql/test/RecordsScaffoldPins.test.ts packages/organization/test/RecordOrderPins.test.ts packages/saml/test/RecordOrderPins.test.ts packages/scim/test/RecordOrderPins.test.ts packages/webhooks/test/RecordOrderPins.test.ts` (7 files, 65/65) |
| **Postgres run** | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run` over the touched plugin packages' contract suites (record in `06-BASELINE.md` "Phase close") |
| **Full suite command** | `pnpm test`, `pnpm test:bdd`, then the gate list in `06-BASELINE.md` |
| **Estimated runtime** | about 10 minutes for the full phase gate; quick run under 30 s |

---

## Sampling Rate

- **After every task commit:** `npx tsc -b tsconfig.json` plus the quick run (docs-only tasks: `pnpm spec:verify:strict`)
- **After every plan wave:** `pnpm test`, `pnpm test:bdd`, the Postgres run
- **Before `/gsd-verify-work`:** every gate in `06-BASELINE.md` at or equal to the Wave 0 baseline
- **Max feedback latency:** 30 seconds per task for the quick loop

---

## Per-Task Verification Map

The spike returned GO with two helpers (`comparators`, `unavailable-label`); `tenant-visibility`, `wire-row`, `sqlstore-make` are recorded not pursued.

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| REC-01 | ADR-EA-041 is Revision 1.7 with the Track A closure note and alternative (e); ADR-EA-046 released (no file, no index row) | spec check + static | `pnpm spec:verify:strict` (PASS 32 / FAIL 0); `grep -n 'Revision note (1.7)' spec/decisions/041-domain-store-ports.md`; `ls spec/decisions \| grep -c '^046'` = 0; `grep -c ADR-EA-046 spec/decisions/index.yaml` = 0 | spec script, commands | ✅ green (re-run this audit: note present line 62, 046 file 0, index rows 0) |
| REC-02 | `06-SPIKE.md` per-helper table, decision rule, verdict (GO, two helpers passed, three `SPIKE-NOT-PURSUED` lines); census reproducible | artifact grep + census | census commands in `06-RESEARCH.md` Q1; `grep -n 'SPIKE-NOT-PURSUED' 06-SPIKE.md`; `06-BASELINE.md` census table (F16 10664 to 10676) | `06-SPIKE.md` | ✅ green |
| REC-03 | comparator helper `Keyset.chronological` (asc, desc flip, createdAt then id by code unit) | unit | `npx vitest run packages/ports/test/Keyset.test.ts` | W1 | ✅ green |
| REC-03 | `StoreFailure.labelled("Store")("op")` names the operation `Store.op` | unit | `npx vitest run packages/sql/test/StoreFailure.test.ts` | W1 | ✅ green |
| REC-03 | all 16 `*Records` modules bind one `StoreFailure.labelled("<OwnName>")`, no hand-written `orStoreUnavailable` closure; discovered by glob (new modules held to the rule) | static pin | `npx vitest run packages/sql/test/RecordsScaffoldPins.test.ts` | W0 (reduced to the durable rule by WR-01, `7f711b0b`) | ✅ green (mutation-checked in `06-REVIEW-FIX.md`) |
| REC-03 | comparator adoption in 11 sites keeps today's ordering for canonical ids (asc/desc, ties, memory twin) | unit (memory) | `RecordOrderPins.test.ts` in `organization`, `saml`, `scim`, `webhooks` (11 of 11 cases fail when the id tie-break is removed, IN-01) | W0, unedited since add | ✅ green |
| REC-03 | no `*Shape` change; every `*Records.d.ts` byte-identical | declaration hash | `shasum -a 256 -c .planning/phases/06-record-store-scaffolding/06-SHAPE-DTS.sha256` (16/16 OK, run this audit, after `tsc -b`) | `06-SHAPE-DTS.sha256` | ✅ green |
| REC-03 | not-pursued helpers: no scaffolding landed for tenant-visibility, wire-row, SqlStore.make | static | `06-BASELINE.md` "Phase close" census (`SqlStore.make` adoption 0, closure shape 16 to 0); `git diff 3be32564 HEAD --stat -- packages/*/test/contract packages/test` empty | closure doc | ✅ green |
| REC-04 | verdicts unchanged: no contract-suite file touched; contract suites pass on SQLite and Postgres | contract + integration | `git diff 3be32564 HEAD --stat -- packages/*/test/contract packages/test` (empty, run this audit); `pnpm test`; Postgres run | existing | ✅ green (Postgres leg recorded at close, 06-12) |
| REC-04 | `Ref` count and lock keys unchanged | static census | `06-BASELINE.md` Wave 0 table (per-module Ref/Semaphore) and Phase close census; no `Ref.make` or lock-key line in the `src` diffs beyond the label and comparator lines | closure doc | ⚠️ partial: no standing test, one-time census (see Findings) |
| REC-04 | operation labels byte-identical | census + partial runtime | binding calls 154 to 154; `failure.operation` assertions in `packages/*/test/contract/*Records.ts` (e.g. `ApiKeyRecords.insert`, `ApiKeyRecords.rotate`); `labelled` builds `<Store>.<op>` | closure doc + contract | ⚠️ partial: the 176-literal Wave 0 label table was dropped by WR-01 as a non-durable oracle (see Findings) |
| REC-04 | `docs/plugin-authoring.md` and `examples/plugin-template/` update last | static | `git diff 3be32564 HEAD --stat -- docs examples features` empty; closure branch "no edit" recorded (`06-BASELINE.md`, docs check: neither teaches the closure or a hand comparator) | closure doc | ✅ green (documented no-edit branch) |
| GATE-01/03 | no dependency change; strata and cycles hold; changeset present | static | `git diff 3be32564 HEAD --stat -- package.json pnpm-lock.yaml packages/*/package.json` empty; `pnpm circular`; `.changeset/record-store-helpers.md` | gates | ✅ green |
| GATE-04 | contract suites of touched stores on Postgres | integration (Postgres) | the Postgres run | W0 / W1 | ✅ green (local CI image, CI confirmation open, no git remote) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky or partial*

---

## Wave 0 Requirements

- [x] `06-BASELINE.md` recorded at the planning HEAD (every gate, Postgres container version)
- [x] Wave 0 oracle pins (`RecordOrderPins.test.ts` x4, label table and `Ref` census) written green against untouched `src`
- [x] `06-SHAPE-DTS.sha256` (16 declaration hashes, identical at close)
- [x] `06-SPIKE.md` written before any go-branch plan

---

## Manual-Only Verifications

None. The Postgres legs run on the local Debian `postgres:16` container; hosted CI cannot run (no git remote), so the record says "run locally on the CI image, CI confirmation open".

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-11-14

## Validation Audit 2026-11-14

| Metric | Count |
|--------|-------|
| Rows audited | 14 |
| Covered | 12 |
| Partial | 2 |
| Missing | 0 |
| Gaps filled by new tests | 0 |
| Escalated | 0 |

Findings (WARNING, not BLOCKER; no test added):

- **Label literals have no standing pin.** WR-01 removed the 176-label Wave 0 table on purpose, because a frozen list fails on every legitimate new operation. Label identity rests on the one-time census (154 binding calls), the `failure.operation` contract assertions for some stores, and the `labelled` unit case. A single mistyped op string in a store without such an assertion would not fail a test. Accepted by the WR-01 disposition; adding a pin would reverse that decision.
- **`Ref` count and lock keys have no standing test.** The Wave 0 `Ref` census was a one-time check; the `src` diff touches only label bindings and comparator lines, so no `Ref` or lock-key line changed (not mechanically re-asserted).
- Ordering is pinned for canonical ids only, matching BEH-EA-036 (WR-02); non-canonical ids intentionally change from `localeCompare` to code-unit order (disclosed in the changeset).
