---
phase: 05
review: 05-REVIEW.md
titles: json
findings:
  - id: IN-01
    severity: info
    disposition: fixed
    title: "directoryTables is typed with a hand-written literal union while partitionedTables derives its type"
  - id: IN-02
    severity: info
    disposition: fixed
    title: "The exported lists are shared by reference and not frozen"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "The new UnknownParent wording is asserted nowhere"
  - id: IN-04
    severity: info
    disposition: fixed
    title: "The reworded TenancyDeclarationInvalid doc comment runs to 118 columns"
  - id: IN-05
    severity: info
    disposition: fixed
    title: "The drift guard proves less than the spec and README sentence suggests"
  - id: IN-06
    severity: info
    disposition: skipped
    title: "owner, sealed, tables and names have no consumer in src or features"
open: 0
total: 6
recorded: 2026-11-14T00:00:00.000Z
---

# Phase 05: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| IN-01 | info | fixed | 05-REVIEW-FIX.md, 2165dafc (`directoryTables` derives its element type with `Extract<Declared, { tenancy: "directory" }>["name"]`; resulting type unchanged) |
| IN-02 | info | fixed | 05-REVIEW-FIX.md, 688b0363 (the catalogue lists and each entry's `sealed` are frozen at the source; `TenantScope` and `LaggingReplica` still alias the same objects, values and order unchanged, every Wave 0 pin green; a test asserts each list is frozen) |
| IN-03 | info | fixed | 05-REVIEW-FIX.md, 415be223 (new AuthTenancy case asserts the `UnknownParent` message names the parent and says "tenant-stamped core table"; additions only) |
| IN-04 | info | fixed | 05-REVIEW-FIX.md, c7f01201 (doc comment re-wrapped, comment only) |
| IN-05 | info | fixed | 05-REVIEW-FIX.md, abefdbe5 (guard comparison split into `unclassified` and `uncreated` with two negative tests, one against a real stray table on both dialects; the ADR-EA-004 key check now looks at nested values; the partitioned-versus-directory split and the rate-limiter migrator hard-code are stated as limits in the test header and the sql README rather than over-claimed, because the schema cannot tell the two tenancy kinds apart and `CoreTablePins` defends the split) |
| IN-06 | info | skipped | CAT-01 mandates the name, owner, tenancy and sealed fields, and the roadmap lists replicated; the unused fields are the contract the requirement asks for and the drift guard and tests are their consumers. Revisit only if a later phase finds them dead |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved.
