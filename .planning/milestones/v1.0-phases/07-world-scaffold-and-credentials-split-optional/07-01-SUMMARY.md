---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 01
subsystem: server-credentials-and-bdd-worlds
tags: [baseline, pin, surface-snapshot, leak-guard, postgres]
requires: []
provides:
  - "CredentialsSurface.test.ts: runtime name pin of the Credentials namespace (18 value names) and compile-time pin of 12 type names"
  - "07-CRED-SURFACE-BEFORE.txt: checker-based export-surface snapshot (sha efbf9b94...)"
  - "07-LEAK-GUARD-BEFORE.txt: 39 sorted [leak-guard] lines, all apps=0 sqlClients=0"
  - "07-BASELINE.md: 16-gate SQLite baseline, CP/WP pins, Postgres leg, intermittents, comparison rule, path allowlist"
affects: [07-02, 07-03, 07-04, 07-05, 07-06, 07-07]
key-files:
  created:
    - packages/server/test/CredentialsSurface.test.ts
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-BASELINE.md
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-CRED-SURFACE-BEFORE.txt
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-LEAK-GUARD-BEFORE.txt
  modified: []
decisions:
  - "Two Postgres-only full-suite failures not on the known list (TenantMiddleware unfiltered-query 5 s timeout; RateLimiterStore SQL sweeper 1 !== 0) are recorded as candidates for the intermittent list, not fixed; each passed alone 3 of 3 and in the next full run"
metrics:
  tasks: 3
  commits: 3
  plan_head_before: 073a5e464c44962b9a1bb0dd124044bf8635abdc
  plan_head_after: 1b3c96b4657aa13922c6d3babdc94f3d4f0008a0
status: complete
actuals:
  tokens: 40000
  tasks: 3
  commits: 3
---

# Phase 7 Plan 1: Baseline and Credentials pin Summary

The Credentials namespace is pinned (18 runtime names, 12 type names, checker snapshot) before any `packages/server/src` change, and the gate, leak-guard and Postgres baseline is recorded at the phase 7 base plus the pin.

## Commits

- `924538e4` test(07-01): pin the Credentials namespace names before the split (alone, one commit for the pin file)
- `a3f92d65` docs(07-01): record phase 7 gate baseline, Credentials surface snapshot and leak-guard capture
- `1b3c96b4` docs(07-01): record the Postgres leg of the phase 7 baseline

## Measured numbers

SQLite: all 16 gates exit as planned on their first run (knip exit 1 with only the 3 `readme-quickstart.ts` rows). tsc 0 errors; error-tags 163 / 137; contract-tests 21 classes; spec PASS 32 / FAIL 0 / SKIP 0; format 1234 files; smoke 30 PASS. bdd 39 files, 1580 passed, 44 skipped. unit 429 files + 6 skipped, 6741 passed, 1 expected fail, 23 skipped. Coverage 91.81 / 85.31 / 87.13 / 92.33. CP 100 files, 1593 passed, 1 expected fail. WP 5 files, 177 passed. Surface snapshot 81 lines, 30 headings (14 / 12 / 4), 0 `import(`, sha reproduced. Leak-guard 39 lines all `apps=0 sqlClients=0`, sha `cfce5d39...`.

Postgres (Debian postgres:16.16, fresh container each run): bdd green (39 files, 1580 / 44; leak-guard lines identical to SQLite). Full unit green on run 3 (435 files, 6784 passed, 1 expected fail, 1 skipped); runs 1 and 2 failed on timing-dependent cases (see below).

## Deviations from Plan

None in code or scope. One measurement finding: the full Postgres unit run needed three attempts. Run 1: admin `ImpersonationRecords (sql)` pair (known intermittent 3) plus `TenantMiddleware.test.ts` "a request under tenant A that runs an unfiltered query sees only A's organization-keyed rows" (5 s timeout; not the listed suspended-organization case). Run 2: passkey ChallengeStore tampered-consume (known intermittent 1) plus `packages/test/test/StoreContract.sql.test.ts` "RateLimiterStore (SQL) > the sweeper deletes expired rows" (not listed). The two unlisted cases passed alone 3 of 3 and in run 3; recorded in 07-BASELINE.md as candidates, nothing fixed (no source changed).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Files exist (pin file, 07-BASELINE.md, both snapshot files); commits `924538e4`, `a3f92d65`, `1b3c96b4` are on the branch; `git diff --name-only ee8b80a1 HEAD -- packages spec features examples docs .changeset knip.json scripts` lists only the pin.
