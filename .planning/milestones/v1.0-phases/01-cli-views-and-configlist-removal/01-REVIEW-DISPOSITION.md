---
phase: 01
review: 01-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "No test pins that a failed or refused `migration apply` emits no `applied` line and a single document"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "`Openapi.emit` now depends on `Output.stringify` matching its own `JSON.stringify(spec, null, 2)`"
  - id: IN-02
    severity: info
    disposition: skipped
    title: "`PluginViews.render` encodes \"has a DOT renderer\" twice"
  - id: IN-03
    severity: info
    disposition: skipped
    title: "`config list` test and the matrix tests derive part of their expected values from the code under test"
  - id: IN-04
    severity: info
    disposition: fixed
    title: "Convoluted assertions in the new `Migration.apply` JSON tests"
open: 0
total: 5
recorded: 2026-11-14T00:00:00.000Z
---

# Phase 01: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | 01-REVIEW-FIX.md, a29c74be (six capture-based failure and refusal tests; mutation check moving `finish(true)` ahead of `Migrations.apply` fails 5 tests) |
| IN-01 | info | fixed | 01-REVIEW-FIX.md, 2769b62f (call-site comment; the `Output.report` move is a locked phase decision and stays, parity pinned by the BEH-EA-205 test) |
| IN-02 | info | skipped | Type-narrowing guard, the rewrite is not shorter; the review itself calls it judgment only |
| IN-03 | info | skipped | The renderers the expectations derive from (`Plugin.renderText`, `renderRules`, `renderEvents`, `EffectiveConfig.read`) are untouched by this phase; literal head and line-count pins already guard the dispatch, and a full literal `config list` pin would couple the test to core defaults |
| IN-04 | info | fixed | 01-REVIEW-FIX.md, a29c74be (whole-document `deepStrictEqual`, pins `pending` and `drift`) |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved.
