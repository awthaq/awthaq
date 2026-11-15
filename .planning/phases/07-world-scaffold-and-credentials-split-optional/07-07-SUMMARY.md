---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 07
subsystem: phase-close
tags: [census, allowlist, gates, postgres, closure]
requires: ["07-06"]
provides:
  - "07-BASELINE.md 'Phase close': census, WORLD-01 / WORLD-02 / CRED-01 closures, path allowlist (residue 0), integrity, margins, flags, SQLite and Postgres gate tables, comparison-rule verdicts 1 to 8, closing Verdict"
affects: []
key-files:
  modified:
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-BASELINE.md
decisions:
  - "Known intermittents were handled by the re-run rule and recorded, not weakened: passkey ChallengeStore (sql) 'tampered' once on SQLite, admin ImpersonationRecords (sql) 'create [atomic]' in two Postgres full unit runs"
metrics:
  tasks: 3
  commits: 3
  plan_head_before: 6e747cd87eb4af3b24a73277af605877214a7d53
  plan_head_after: 57bfd129b929cbcc6c423af94bb174076dbe7fda
status: complete
actuals:
  tokens: 9000
  tasks: 3
  commits: 3
---

# Phase 7 Plan 7: Phase close Summary

Phase 7 is closed on evidence: the census, the path allowlist (residue 0), the empty-diff checks and every gate hold against `07-BASELINE.md` on SQLite and on the CI Postgres image, with every comparison rule MET and the three requirement closures recorded in the baseline file.

## Commits

- `8aca93c9` docs(07-07): record the phase 7 structural close, census and closures
- `f702dd3a` docs(07-07): record the phase 7 gate close on SQLite
- `57bfd129` docs(07-07): record the phase 7 gate close on Postgres and the verdict

## Closure evidence (all in 07-BASELINE.md "Phase close")

- Census: inline `authEvents.stream` in the three adopters 3 to 0; Worlds importing the scaffold 0 to 3; Worlds classified 31; bdd files 39 to 40; OrganizationWorld `Layer.effectDiscard` 1; Credentials.ts declarations 45 to 0; five internal modules; `new WeakMap` 3 in `Resolution.ts` and 0 in `Credentials.ts`; 13 non-planning paths; allowlist residue 0.
- WORLD-01 (read as "composes with `TestAuth.layer` without re-wrapping it"): Admin 22/3, Password 14/2, Domain 14/2 removed/added; the helper is 44 lines; net +1 line in the code base (51 added against 50 removed; the 43-line type pin is counted separately, +44 with it), kept for locality of the lost-publish race fix, not for size; `lazyApp` and `TestClock` not pursued (single calls or options of `TestAuth`); table and guard (31 Worlds: 3 scaffolded, 5 hand-wired, 23 no-tail).
- WORLD-02: five hand-wired Worlds, OrganizationWorld, the 23 no-tail Worlds, `LeakGuard.ts` and `packages/test` have an empty diff; the missing-service mutation (omit `NoBreachHttpClient`) is the red compile gate; dropping a plugin from the `Auth.make` tuple stays green; the helper imports no host.
- CRED-01: `Credentials.ts` 678 lines became a 52-line facade (0 declarations) over five internal modules (708 lines); surface snapshots byte-identical (sha `efbf9b94...9a1d`); runtime-name pin has one commit; importers, ADR, spec, docs and changesets unedited.

## Gate results

- SQLite: tsc -b 0, tests typecheck 0 (the two pre-existing TS377149 warnings), circular 0, error-tags 163/137, transactions, contract-tests 21, lint 0 (94 warnings, 87 `.claude/` + 7 `RequestContextSteps.ts`), format 1242 files (+8), readmes, workspace, bdd 40 files / 1581 passed / 44 skipped, unit 429 + 6 skipped files / 6741 passed / 1 expected fail / 23 skipped, coverage 91.81 / 85.31 / 87.13 / 92.33, spec PASS 32 FAIL 0 SKIP 0, knip exit 1 (pre-existing, filtered output identical, `knip.json` unchanged), package smoke 30 PASS, CP 100 / 1593 / 1, WP + guard 6 / 178.
- Postgres (container `awthaq-p3-pg`, Debian `postgres:16`, recreated before each group, explicit `AWTHAQ_POSTGRES_URL`): full unit 435 files / 6784 passed / 1 expected fail / 1 skipped (equal to the baseline), full bdd 40 files / 1581 passed / 44 skipped, CP 100 / 1596 / 1, WP + guard 6 / 178; 0 crash-symptom log matches. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).
- Leak-guard: sorted lines equal `07-LEAK-GUARD-BEFORE.txt` plus exactly the guard file's line, on SQLite and Postgres.

## Intermittents hit

- SQLite unit run 1: passkey `ChallengeStore (sql)` "consume [atomic]: false for any other value, a tampered one included" (1 failed, 6740 passed); re-run 1 green (6741 passed). Note: in the baseline this case fired only on Postgres; here it fired on the default SQLite-backed run.
- Postgres full unit runs 1 and 2: admin `ImpersonationRecords (sql)` "create [atomic]: ..." (5 s timeout, one half of the known pair); run 3 (second re-run) green. The two unlisted candidates from plan 07-01 (organization `TenantMiddleware` unfiltered-query case, `StoreContract.sql` sweeper) did not fire.

## Deviations from Plan

None - plan executed exactly as written (the rule-5 verdict was placed in numeric position, and the comparison rule's rule 8, not listed in the plan's verdict set, was also given a MET line).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- `07-BASELINE.md` carries one `## Phase close`, the three closure headings, one `Verdict` line, 0 `UNMET`; commits `8aca93c9`, `f702dd3a`, `57bfd129` are on the branch; `git diff --name-only ee8b80a1 HEAD | grep -vE '<allowlist>' | grep -c .` prints 0.
