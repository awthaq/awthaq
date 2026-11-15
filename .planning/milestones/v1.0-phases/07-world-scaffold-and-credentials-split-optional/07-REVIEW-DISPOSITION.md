# Phase 7 review disposition

Review: `07-REVIEW.md` (0 critical, 3 warning, 3 info). Fixes: `07-REVIEW-FIX.md`.

| ID | Disposition | Note |
|----|-------------|------|
| WR-01 | Fixed (`78bc0444`), wording aligned by orchestrator | Missing-service compile gate now pinned by a positive control plus `@ts-expect-error` in `EventCapture.types.ts` (checked by the `features` project of `tsc -b`). ROADMAP Goal and criteria and REQUIREMENTS WORLD-01/02 wording aligned to "composes with `TestAuth.layer`" and "missing-service gate"; flagged in the milestone report. |
| WR-02 | Fixed (`5957f3b8`) | Guard strips block comments, requires a real `captureEvents(` call and an import statement, rejects `.stream/.subscribe/.on/.onBatch` taps; seven recorded mutations. |
| WR-03 | Fixed (`c94715a5`) | Exact 12-name type clause and no other export (text check, with a `shortcut:` note: no TS JS API in tests); `Rotation`/`Scope`/`Resolved` frozen with type equality. |
| IN-01 | Fixed (`18df9616`) | Comment-only; verbatim multiset check re-run. |
| IN-02 | Investigated, helper kept (`85c3315d`) | `subscribe` plus a plain fork failed 5 Admin scenarios (consumer first-run is observable); `subscribe` plus `startImmediately` removes nothing. D-11's reason for OrganizationWorld corrected: the difference is the consumer's first run, not registration; whether Organization's steps tolerate the helper's timing was not measured. |
| IN-03 | Fixed (`78bc0444`) | Redundant claims 1 and 3 of the type pin deleted (deletion is the cleanest end state); marked "requires human verification" by the fixer, accepted. |
