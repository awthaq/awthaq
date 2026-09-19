---
name: postgres-performance-specialist
title: Postgres Performance Specialist
type: archetype
ecosystem: Database & Persistence
---

# Postgres Performance Specialist

## Role

This specialist tunes Postgres for high-throughput, latency-sensitive read/write patterns. Day to day work covers index design, query plan analysis with `EXPLAIN ANALYZE`, connection pool sizing, and diagnosing lock contention or query regressions under production load.

## Why relevant to effect-auth

Every request effect-auth handles resolves a principal through session and credential lookups executed against `@effect/sql-pg` repositories in `packages/sql`. These are the hottest queries in the system — session verification runs on nearly every authenticated request — so index coverage on `session.token`, `user.id`, and OAuth/passkey lookup tables directly determines request latency. This specialist also owns connection pool configuration for the `PgClient` layers that plugin packages (`packages/oauth`, `packages/passkey`, `packages/organization`) share via Effect's dependency injection.

## Core expertise

- Composite and partial index design for lookup-heavy, high-cardinality tables
- Reading and optimizing query plans (`EXPLAIN (ANALYZE, BUFFERS)`), spotting sequential scans and bad row estimates
- Connection pooling strategy (pool sizing vs. `max_connections`, statement timeouts, pgbouncer transaction mode implications)
- Vacuum/autovacuum tuning for high-churn tables like sessions
- Diagnosing lock contention and deadlocks under concurrent writes
- Read/write query separation and prepared statement caching

## Hiring rubric

**Must demonstrate**
- Can read an `EXPLAIN ANALYZE` output and identify the actual bottleneck, not just guess from the query text
- Knows the tradeoffs of pgbouncer transaction pooling with a library that manages its own connection lifecycle (as `@effect/sql-pg` does)
- Has designed an index for a hot lookup path in production

**Strong signal**
- Has debugged autovacuum falling behind on a high-churn table (e.g., session inserts/deletes) and the resulting bloat
- Can explain how to safely add an index concurrently on a live auth table without blocking writes

**Red flags**
- Reaches for "add more indexes" without considering write amplification on a table like `session` that's inserted/deleted constantly
- No familiarity with connection pool exhaustion symptoms or how to diagnose them

## Interview probes

- "Session verification is p99 latency-critical and runs on every request. What indexes and query shape would you use for `SELECT * FROM session WHERE token = $1 AND expires_at > now()`?"
- "How would you size a connection pool for a `PgClient` Layer shared across five plugin packages under Effect's DI, each with independent concurrency?"
- "Sessions churn constantly (short-lived, high insert/delete rate). How do you keep autovacuum from falling behind on that table?"
