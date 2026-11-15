---
phase: 04
review: 04-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "Memory-twin compensation re-creates a claim for a connection that a concurrent removal just deleted"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "The connection write seals the client secret through KeyProvider while holding the org-wide advisory lock"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "Swallowed compensation hides its own failures and double-logs on a poisoned Postgres transaction"
  - id: IN-02
    severity: info
    disposition: fixed
    title: "Effect.die on SamlDomainTaken in refreshMetadata guards a state that cannot occur"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "The Postgres race oracle never asserts the create outcome and relies on wall-clock sleeps"
  - id: IN-04
    severity: info
    disposition: deferred
    title: "The shared domain normaliser has no cap on domain count or length"
  - id: IN-05
    severity: info
    disposition: fixed
    title: "RecordsBoundary scanner matches only the import { ... } from form"
  - id: IN-06
    severity: info
    disposition: fixed
    title: "The exposed create trusts a caller-supplied connectionId"
open: 0
total: 8
recorded: 2026-11-14T00:00:00.000Z
---

# Phase 04: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | 04-REVIEW-FIX.md, 8b0c7211 (`ConnectionProtocol.isGone`: a write that reports the connection gone releases its claims instead of restoring `previous`; memory-leg tests for update-vs-remove and remove-vs-remove; the stale-`previous` read stays a documented limit in the lifecycle header and the changeset, SQL is unaffected because the transaction rolls back) |
| WR-02 | warning | fixed | 04-REVIEW-FIX.md, 0a79f215 (`ConnectionRecords.sealSecret` and opaque `PreparedSecret`; the OIDC store seals in `prepare`, before the lock and the transaction; a spy test pins seal-then-transaction order) |
| IN-01 | info | fixed | 04-REVIEW-FIX.md, 05101706 (compensation skipped on `StoreUnavailable` and run under `Effect.ignoreCause`) |
| IN-02 | info | fixed | 04-REVIEW-FIX.md, 0324a09d (`lifecycle.refresh` and `SamlRecords.refresh` typed without `SamlDomainTaken`; the `catchTag`/`Effect.die` is gone) |
| IN-03 | info | fixed | 04-REVIEW-FIX.md, 594a82d4 (race gated on advisory-lock waiters, create outcome asserted `InvalidConnection`; removing the in-lock re-check turns it red) |
| IN-04 | info | deferred | 04-REVIEW-FIX.md, 774d6688 (recorded as F-04-02 in 04-FINDINGS.md: a count and length cap would change OIDC and direct-caller validation inside a behaviour-preserving refactor) |
| IN-05 | info | fixed | 04-REVIEW-FIX.md, cfd67eca (scanner refuses every import form of `@awthaq/organization/records`; self-test of 11 refused and 3 allowed forms) |
| IN-06 | info | fixed | 04-REVIEW-FIX.md, e85a3af4 (precondition documented in the lifecycle header, the changeset and the README; the claim table is keyed `(domain, connectionId)`, so keying on protocol is not clean) |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved.
