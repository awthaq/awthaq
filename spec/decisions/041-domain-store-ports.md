# ADR-EA-041: Core Domain Services Are Written Once Over Atomic Store Ports

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-041 |
> | Revision | 1.6 |
> | Effective Date | 2026-11-10 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-13): Initial release (plan 02) <br> 1.1 (2026-10-13): Status flipped to Accepted, implemented: every phase of plan 02 shipped; `layerMemory` and `layerSql` removed from the five modules in favour of `Persistence.memory`/`Persistence.sql()` <br> 1.2 (2026-10-18): the bundles provide `RelayCursorStore` too and `StoreContract.relayCursor` is its bar: the relay's position joins the seam, closing plan 02's non-goal (architecture plan 23) <br> 1.3 (2026-10-18): decision 3 and 4: the SQL adapters own their statements and `Persistence.sql` is `CoreStoresSql.layer`; there is no repository layer; decision 6 runs on libSQL; alternative (d) recorded (architecture plan 16) <br> 1.4 (2026-11-08): Decision 4: a host chooses the bundle once, as `AuthHost`'s `persistence` (ADR-EA-044, architecture plan 15) <br> 1.5 (2026-11-08): decision 5: the substrate is `SqlStore.make` (`write`/`read`/`once`) plus `SqlStore.atomically`; one SQL adapter shape for core stores and plugin records, unique violations classified by `StoreFailure.isUniqueViolation` (architecture plans 28 and 25). Decision 9: plugin record stores: verdicts, atomic primitives, `RecordsContract` (architecture plan 25) <br> 1.6 (2026-11-10): decision 6: the core contract takes decision 9's shape (verdicts per operation, one machinery with RecordsContract), StoreContract.run owns its modes, and RateLimiterStore joins it (architecture plan 37) |

---

## Context

Each of the five persistence-backed core services (`Sessions`, `Users`, `Accounts`, `Verification`, `AuditLog`) shipped two complete implementations of one interface: `layerMemory`, over a `Ref`, and `layerSql`, over `@awthaq/sql`'s repositories. Each restated every domain rule (hashing, expiry, rotation and its grace window, supersede, reuse detection, eviction, events, hooks, error mapping, announcements), and the two copies drifted: the review found more than forty behavioural differences, nine of them live bugs. A concurrent `Accounts.unlink` could leave a Postgres user with no account; `revoke`, `reauthenticate` and reuse detection were atomic in memory and read-then-write in SQL; `supersedes` could tombstone another user's session; the two layers disagreed at the reservation boundary. A composition could also mix a memory store with a SQL transaction by accident, so a swapped module's writes silently left the transaction.

The drift lives in the I/O sequencing around persistence, not in the pure rules, which were already shared helpers. A shared helper module therefore cannot fix it: only a seam that makes each read-modify-write one primitive with a stated atomicity can.

## Decision

**1. Each service is written once, over a store port.** `Sessions.layer`, `Users.layer`, `Accounts.layer`, `Verification.layer` and `AuditLog.layer` each require only their port (plus `Crypto`, `AuthEvents` and hooks) and contain every domain rule. No `layerMemory` or `layerSql` remains on a service.

**2. Every primitive on a port is atomic by contract.** A read-modify-write the domain relies on (a revoke that must publish once, a CAS rotation, a once-only reuse flag, a last-account check, a verification claim-or-spend) is a single primitive whose atomicity is part of its stated contract: one `Ref.modify` in the memory adapter, one statement or one transaction in the SQL adapter. A primitive fails only with the typed `StoreUnavailable` (ADR-EA-028).

**3. Placement.** The ports, the pure contract helpers (`isLive`, `evictionOrder`, `unionMethods`) and the `Ref` adapters live in `@awthaq/ports` (stratum 2, beside `RateLimiter`'s store, the precedent); the SQL adapters, each owning its statements, sealing hook, tenant stamp and dialect branches, live in `@awthaq/sql` (stratum 3) and there is no repository layer beneath them (plan 16); the domain services and the matched bundles live in `@awthaq/core` (stratum 4). The identifier brands move to `@awthaq/ports` (`Ids`), re-exported by `@awthaq/sql`'s `Models`, so a port and its adapters share one type.

**4. Matched bundles.** `Persistence.memory` provides every `Ref` store (the five domain stores and the event relay's `RelayCursorStore`) plus `SqlTransaction.layerNoop`; `Persistence.sql(options)` (`@awthaq/sql`'s `CoreStoresSql.layer`) provides every SQL store plus `SqlTransaction.layerSql` over one `SqlClient`. A composition cannot pair a memory store with a SQL transaction by accident, and the README quickstart drops from six repositories and five layers to one call. One store may still be swapped (ADR-EA-014): it then sits outside the `SqlTransaction`, so its participation in erasure (ADR-EA-031) must be idempotent and retry-safe. A host chooses the bundle once, as `AuthHost`'s `persistence`; the same choice selects every plugin's records bundle ([ADR-EA-044](044-host-composition.md)).

**5. One adapter substrate, one adapter shape.** A SQL store adapter (a core `<Port>Sql`, or a plugin's records `layerSql`) is one module over the ambient `SqlClient`:

- It resolves the dialect once (`Models.resolveDialect`; codecs from `Models.makeModels`/`dialectFields`).
- It declares its own statements (`SqlSchema`, and `SqlModel.makeRepository` for generated CRUD).
- It runs each primitive through `SqlStore.make(sql)`. `write`: classified by `StoreFailure` (an outage is `StoreUnavailable`; a decode failure or a refused statement is a defect), with a transient failure retried at the top level only, never inside a caller's transaction. `read`/`once`: the same classification, never retried, for reads and for writes whose repetition would change their answer. The label is `<Port>.<primitive>`.
- It treats a constraint failure as a domain outcome only through `StoreFailure.isUniqueViolation`, whatever the driver called it.
- It opens `SqlTransaction.transactional(sql)` only to make one primitive atomic: a savepoint inside a caller's (OHS-002). When the primitive keeps an invariant over several rows, it opens `SqlStore.atomically(sql, key)` instead, the same transaction holding a lock named by the invariant's scope (decision 9).
- It captures the causal token on writes that change a replica-eligible listing (ADR-EA-024).
- It stamps the tenant through `Tenant.stamp`/`Tenant.resolve` (core tables) or `TenantScoped` (plugin tables).
- It seals through `SealedColumn`.

The core adapters follow it (plan 16). The plugin records adapters follow it as plan 25 migrates each store (organization first: `SqlStore.atomically`, `isUniqueViolation`; the remaining stores still pipe each method through `StoreFailure.orStoreUnavailable`, which is the same classification without the retry). The tenant-stamp rule is `Tenant.stamp`/`Tenant.resolve` in `@awthaq/ports`, used by both adapter families.

**6. The contract suite is the adapter bar, in decision 9's shape.** `@awthaq/test`'s `StoreContract` holds one suite per core store port (`auditLog`, `verification`, `accounts`, `users`, `sessions`, `relayCursor`, `rateLimiterStore`), keyed by the port's operations: every operation carries a verdict (`read`, `write`, `atomic` with at least one `race` case, `exempt` with a reason), and one without does not compile. The verdict machinery is `RecordsContract`'s. `StoreContract.run(framework, mode)` owns the modes: the `Ref` adapters of `Persistence.memory` and `RateLimiter.layerStoreMemory`; the SQL adapters of `CoreStoresSql.layer` and `RateLimiterStoreSql.layerStoreSql` over a given client (SQLite `:memory:`, a WAL file, libSQL, a Postgres schema under `pnpm test:pg`), migrated, with the test `Encryption` and the declared user-field columns; and the sealed bundle (`encryptPii`) for the ports it changes. Each case gets a fresh adapter and a `TestClock`. `StoreContract.runSuite` runs one suite on any other adapter of its port, such as a KV `SessionStore`, which is acceptable when it passes. Domain tests run once, on the `Ref` adapters.

**7. Operation labels stay at the service level.** `StoreUnavailable.operation` is visible on the wire and asserted by tests. Adapters log the precise primitive (`SessionStore.flagReuse`); the domain relabels the failure to the service operation (`Sessions.verify`), so wire labels do not change.

**9. Plugin record stores follow decisions 2 and 6.** A plugin's domain is already written once in its system modules (ADR-EA-040), so its record store keeps its two adapters, bundled as `records` (BEH-EA-334). Every operation of a record store carries a verdict (`read`, `write`, `atomic` with at least one `race` case, `exempt` with a reason) in a `RecordsContract` suite (`@awthaq/test`), one suite per store keyed by its `/records/` key; an operation without a verdict does not compile. `runPluginContractTests` requires the suites for every store a plugin's bundle provides (`records: { suite, suites }`; a missing key does not compile) and runs every case on memory and SQL (SQLite, and Postgres under `pnpm test:pg`), a fresh adapter per case. An invariant a system module relies on across rows or across a read (the last owner, the last team, a quota, the team forest, a status transition, a "still live" condition, a row and its ledger link) is enforced by the primitive that writes: one `Ref.modify`, or one conditional statement (`UPDATE … WHERE <condition> RETURNING`), or one transaction holding `SqlStore.atomically(sql, key)` (`pg_advisory_xact_lock(hashtextextended(key, 0))` on Postgres; keys are `<table>:<scope>:<id>`). A transaction alone is not atomicity under READ COMMITTED. The module's earlier check only orders errors (before its veto hook); the primitive's answer decides.

**8. Canonical behaviour for each drift.** Each difference between the twins takes one stated behaviour, justified against a BEH-EA, INV-EA or ADR-EA id (see `.planning/02-domain-store-seam/PLAN.md` section 3.8 and "Decisions taken"); the notable ones: `supersedes` of another user's or a tombstoned session founds a fresh family; reuse and revoke publish exactly once; the amr union and the verification claim are atomic; a reservation is expired iff `now >= expiresAt`; identity reads never decrypt tokens; `updatedAt` bumps on every row write; an audit `append` is idempotent on `eventId`.

## Consequences

**Positive**: one rule lives in one place; the atomicity every caller relies on is stated and tested on every adapter; a KV `SessionStore` (ADR-EA-014) means nine primitives and a contract suite, not a third 500-line copy of `Sessions`; the persistence internals (`Model.Override`, `JSON.stringify(amr)`, `actingAsType`) leave the domain.

**Decision 9** costs one advisory lock per guarded write and serialisation per scope (an organization's membership, its team forest, an inviter's invitations, a tenant's endpoints), all human-rate administrative writes. It gains one written bar for every record adapter, including a host's own through `@awthaq/organization/records`.

**Negative**: a store adapter is a new thing to write and test for a new backend; one extra read on the verification claim path (the row is judged first, so a miss is charged to it); a few operations take one more round trip than a hand-tuned SQL statement would. No schema change: every phase is a query or code change and reverts alone.

## Alternatives considered

- **(a) Ports in `@awthaq/core`, SQL adapters in `@awthaq/sql`.** Makes `@awthaq/sql` depend on core while core depends on sql: a package cycle that `tsc -b` refuses and `pnpm circular` flags.
- **(b) Ports and both adapters in `@awthaq/sql`.** No cycle, but a KV backend would depend on a package named `sql`, and ADR-EA-014's "`Sessions` is a port" would stay nominal.
- **(c) Ports in `@awthaq/ports`, the memory adapter beside each port, SQL adapters in `@awthaq/sql`**, chosen: the exact precedent of `RateLimiter.RateLimiterStore` and `RateLimiterStoreSql`.
- **(d) SQL adapters over repositories** (plan 02's interim choice). Reversed by plan 16: each repository had exactly one caller, so the second seam bought no substitution; it doubled every row shape and split each primitive's atomicity argument across two files.
- **Keep the twins with a shared helper module.** Rejected: the helpers already exist; the drift is in the I/O sequencing, which only an atomic seam fixes.
- **A differential memory/SQL parity harness as the plugin bar** (plan 24 Track B). Rejected as the bar for decision 9: it states no semantics and cannot see races (both adapters fail a check-then-write identically). It remains a possible addition.
- **SERIALIZABLE isolation for decision 9.** The `SqlTransaction` port has no isolation option, and a serialization failure inside a caller's transaction would need a retry loop in every caller (the transient retry runs only at the top level).
- **Row `FOR UPDATE` for decision 9.** A zero-row hole: a quota over an empty set, or two inserts into a scope with no rows, lock nothing.
- **Plugin cases in each plugin's `src`** (so a host's adapter could run them). Ships test code in runtime packages; no host is known to bring its own plugin record adapter (plan 25 Q1).
- **Transactional memory (`TxRef`) now.** Rejected for this decision: plans 01 and 07 already give memory compositions compensation where a unit must leave nothing behind, and `Effect.tx` re-runs a body on conflict, including its publishes and crypto, which would need every service re-audited. Revisit if memory compositions need real rollback.

## Related

[ADR-EA-004](004-database-neutral-models.md), [ADR-EA-014](014-session-storage-backend-neutrality.md), [ADR-EA-016](016-verification-sql-claiming.md), [ADR-EA-018](018-tenancy-is-an-organization.md), [ADR-EA-024](024-read-replica-routing.md), [ADR-EA-028](028-infrastructure-error-policy.md), [ADR-EA-031](031-erasure-registry-and-retention.md), [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md), [ADR-EA-039](039-verification-redeem.md), [ADR-EA-040](040-plugin-exposes-domain-services.md).
