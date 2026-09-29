# Embedded SQLite Deployment: Write Ceiling and the Move to Postgres
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-APP-04 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Appendix — Operator Guidance |
> | Change History | 1.0 (2026-09-29): Initial release (SEA-002) |
---

This appendix is for an operator running awthaq's `layerSql` compositions over an embedded SQLite database (`@effect/sql-sqlite-node`, backed by `node:sqlite`) — the shape the README's local smoke test and every SQLite-backed test in this repository use. It states what that shape can and cannot carry, so the decision to move to Postgres is made on a signal rather than on an outage. It complements [ADR-EA-014](../decisions/014-session-storage-backend-neutrality.md), which fixes what every session backend must guarantee, and [ADR-EA-004](../decisions/004-database-neutral-models.md), which is why the same `Models`/`Repositories` run on both dialects.

## What the client does

`@effect/sql-sqlite-node` opens **one serialized connection**: every statement, and every explicit transaction for its whole duration, takes a single permit, so **writes serialize** (a transaction also holds the write lock when it only reads). WAL mode is enabled, which lets the file be read while it is being written, but a single connection means one statement runs at a time within the process regardless. `node:sqlite` is synchronous, so each statement **blocks the Node event loop** for its duration — a slow statement is a stall for every in-flight request, not just its own.

When the database file is locked by *another* connection or process, SQLite waits up to `busyTimeout` (default **5 seconds**), then fails the statement. awthaq's `layerSql` maps that `SqlError` to a defect today (MA-004 tracks giving environmental failures a typed channel), so a busy timeout on a hot path surfaces as a `500`, not a retry.

## What writes awthaq generates

Session traffic is the steady-state writer. Reads (`verify`, `findOwned`, `list`) are plain selects. Writes are:

- one insert per sign-in, and one tombstone plus one insert per privilege change (`issue` with `supersedes`, atomic — [BEH-EA-053](../behaviors/07-sessions.md));
- **at most one idle-refresh/rotation write per session per `touchEvery`** (default one hour, [BEH-EA-052](../behaviors/07-sessions.md)) — the throttle is what keeps steady-state writes proportional to *active sessions per hour*, not to requests;
- verification-token inserts and consumes, rate-limiter bookkeeping when a store-backed limiter is used, and audit-log inserts.

## Sizing guidance

Because the touch write is throttled, a rough steady-state write rate is `activeSessions / touchEvery` plus sign-in and token traffic. With the default one-hour `touchEvery`, ten thousand concurrently active sessions is on the order of three touch writes per second — comfortably within an embedded file's single-writer capacity. The ceiling is reached by *bursts*, not averages: a login storm, a mass revocation, a retention sweep deleting a large expired set, or a long transaction that holds the single connection while other requests queue behind it. Watch for statements that take tens of milliseconds (each is an event-loop stall) and for any `SqlError` whose reason is a busy or locked database.

## When to move to Postgres

Move when any of these holds:

1. **More than one process must write** to the same database — embedded SQLite is a single-host, ideally single-process store. Multi-instance deployments also need a shared store for revocation to propagate at all (ADR-EA-014; the memory layers are single-process too).
2. Sustained write latency is visible to users (event-loop stalls from synchronous statements, request latency tracking write bursts).
3. A busy-timeout `SqlError` has ever reached production traffic.
4. The database needs online backup, replication or read replicas beyond what a file copy gives.

The move is a composition change, not a code change: swap `SqliteClient.layer(...)` for `PgClient.layer(...)` and run the same `CoreMigrations.coreMigrations` (dialect-branched internally). The README's "Swapping in Postgres for real" section is the recipe.

## Not yet covered

A bounded retry (a `Schedule`) around session issue and touch for a transient busy condition depends on MA-004 giving environmental SQL failures a typed error channel; until then a busy timeout is a defect, and this appendix's guidance is to size and monitor so it never occurs.
