# ADR-EA-041: Core Domain Services Are Written Once Over Atomic Store Ports

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-041 |
> | Revision | 1.0 |
> | Effective Date | 2026-10-13 |
> | Status | Accepted |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-13): Initial release (plan 02) |

---

## Context

Each of the five persistence-backed core services (`Sessions`, `Users`, `Accounts`, `Verification`, `AuditLog`) shipped two complete implementations of one interface: `layerMemory`, over a `Ref`, and `layerSql`, over `@awthaq/sql`'s repositories. Each restated every domain rule (hashing, expiry, rotation and its grace window, supersede, reuse detection, eviction, events, hooks, error mapping, announcements), and the two copies drifted: the review found more than forty behavioural differences, nine of them live bugs. A concurrent `Accounts.unlink` could leave a Postgres user with no account; `revoke`, `reauthenticate` and reuse detection were atomic in memory and read-then-write in SQL; `supersedes` could tombstone another user's session; the two layers disagreed at the reservation boundary. A composition could also mix a memory store with a SQL transaction by accident, so a swapped module's writes silently left the transaction.

The drift lives in the I/O sequencing around persistence, not in the pure rules, which were already shared helpers. A shared helper module therefore cannot fix it: only a seam that makes each read-modify-write one primitive with a stated atomicity can.

## Decision

**1. Each service is written once, over a store port.** `Sessions.layer`, `Users.layer`, `Accounts.layer`, `Verification.layer` and `AuditLog.layer` each require only their port (plus `Crypto`, `AuthEvents` and hooks) and contain every domain rule. No `layerMemory` or `layerSql` remains on a service.

**2. Every primitive on a port is atomic by contract.** A read-modify-write the domain relies on (a revoke that must publish once, a CAS rotation, a once-only reuse flag, a last-account check, a verification claim-or-spend) is a single primitive whose atomicity is part of its stated contract: one `Ref.modify` in the memory adapter, one statement or one transaction in the SQL adapter. A primitive fails only with the typed `StoreUnavailable` (ADR-EA-028).

**3. Placement.** The ports, the pure contract helpers (`isLive`, `evictionOrder`, `unionMethods`) and the `Ref` adapters live in `@awthaq/ports` (stratum 2, beside `RateLimiter`'s store, the precedent); the SQL adapters, over the existing repositories, live in `@awthaq/sql` (stratum 3); the domain services and the matched bundles live in `@awthaq/core` (stratum 4). The identifier brands move to `@awthaq/ports` (`Ids`), re-exported by `@awthaq/sql`'s `Models`, so a port and its adapters share one type.

**4. Matched bundles.** `Persistence.memory` provides every `Ref` store plus `SqlTransaction.layerNoop`; `Persistence.sql(options)` provides every SQL store plus `SqlTransaction.layerSql` over one `SqlClient`. A composition cannot pair a memory store with a SQL transaction by accident, and the README quickstart drops from six repositories and five layers to one call. One store may still be swapped (ADR-EA-014): it then sits outside the `SqlTransaction`, so its participation in erasure (ADR-EA-031) must be idempotent and retry-safe.

**5. One adapter substrate.** `@awthaq/sql`'s `SqlStore.write`/`read` wrap `StoreFailure` (plan 05): an outage is `StoreUnavailable`, a decode failure is a defect, a transient failure is retried at the top level only (never inside a caller's transaction), and a primitive that changes what a replica-eligible listing returns captures the causal token (ADR-EA-024). The tenant-stamp rule is `Tenant.stamp`/`Tenant.resolve` in `@awthaq/ports`, used by both adapter families.

**6. The contract suite is the adapter bar.** `@awthaq/test`'s `StoreContract` holds each port's cases as data, concurrency cases included, and runs on the `Ref` adapters, SQLite `:memory:`, SQLite WAL file and Postgres (`pnpm test:pg`). An adapter, including a third party's KV `SessionStore`, is acceptable when it passes. Domain tests run once, on the `Ref` adapters.

**7. Operation labels stay at the service level.** `StoreUnavailable.operation` is visible on the wire and asserted by tests. Adapters log the precise primitive (`SessionStore.flagReuse`); the domain relabels the failure to the service operation (`Sessions.verify`), so wire labels do not change.

**8. Canonical behaviour for each drift.** Each difference between the twins takes one stated behaviour, justified against a BEH-EA, INV-EA or ADR-EA id (see `.planning/02-domain-store-seam/PLAN.md` section 3.8 and "Decisions taken"); the notable ones: `supersedes` of another user's or a tombstoned session founds a fresh family; reuse and revoke publish exactly once; the amr union and the verification claim are atomic; a reservation is expired iff `now >= expiresAt`; identity reads never decrypt tokens; `updatedAt` bumps on every row write; an audit `append` is idempotent on `eventId`.

## Consequences

**Positive**: one rule lives in one place; the atomicity every caller relies on is stated and tested on every adapter; a KV `SessionStore` (ADR-EA-014) means nine primitives and a contract suite, not a third 500-line copy of `Sessions`; the persistence internals (`Model.Override`, `JSON.stringify(amr)`, `actingAsType`) leave the domain.

**Negative**: a store adapter is a new thing to write and test for a new backend; one extra read on the verification claim path (the row is judged first, so a miss is charged to it); a few operations take one more round trip than a hand-tuned SQL statement would. No schema change: every phase is a query or code change and reverts alone.

## Alternatives considered

- **(a) Ports in `@awthaq/core`, SQL adapters in `@awthaq/sql`.** Makes `@awthaq/sql` depend on core while core depends on sql: a package cycle that `tsc -b` refuses and `pnpm circular` flags.
- **(b) Ports and both adapters in `@awthaq/sql`.** No cycle, but a KV backend would depend on a package named `sql`, and ADR-EA-014's "`Sessions` is a port" would stay nominal.
- **(c) Ports in `@awthaq/ports`, the memory adapter beside each port, SQL adapters in `@awthaq/sql`**, chosen: the exact precedent of `RateLimiter.RateLimiterStore` and `RateLimiterStoreSql`.
- **Keep the twins with a shared helper module.** Rejected: the helpers already exist; the drift is in the I/O sequencing, which only an atomic seam fixes.
- **Transactional memory (`TxRef`) now.** Rejected for this decision: plans 01 and 07 already give memory compositions compensation where a unit must leave nothing behind, and `Effect.tx` re-runs a body on conflict, including its publishes and crypto, which would need every service re-audited. Revisit if memory compositions need real rollback.

## Related

[ADR-EA-004](004-database-neutral-models.md), [ADR-EA-014](014-session-storage-backend-neutrality.md), [ADR-EA-016](016-verification-sql-claiming.md), [ADR-EA-018](018-tenancy-is-an-organization.md), [ADR-EA-024](024-read-replica-routing.md), [ADR-EA-028](028-infrastructure-error-policy.md), [ADR-EA-031](031-erasure-registry-and-retention.md), [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md), [ADR-EA-039](039-verification-redeem.md).
