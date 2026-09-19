---
name: effect-sql-repository-specialist
title: Effect SQL Repository Specialist
type: archetype
ecosystem: Effect
---

# Effect SQL Repository Specialist

## Role

This specialist builds and maintains the persistence layer of an Effect application: repository modules built on `@effect/sql`, query construction, transaction boundaries, and migration strategy. The daily work is writing and reviewing SqlModel-based repositories and reasoning about correctness under concurrent writes.

## Why relevant to effect-auth

`packages/sql` provides the SqlModel.makeRepository-based persistence for sessions, credentials, OAuth accounts, passkeys, API keys, and organization/role data, targeting both `@effect/sql-pg` and `@effect/sql-sqlite-node` so the same plugin code runs against Postgres in production and SQLite in the example workspace and BDD suite. This role is responsible for keeping repository queries correct across both drivers (e.g., camelCase-vs-quoted column handling, as fixed in a recent hardening ticket), for transaction boundaries around multi-table writes like session-plus-audit-log inserts, and for query performance as the roles/organization plugins add joins.

## Core expertise

- SqlModel.makeRepository patterns and hand-written query builders with `@effect/sql`
- Transaction boundary design (Effect.transaction) for multi-table writes and rollback semantics
- Cross-dialect correctness between Postgres and SQLite (column quoting, type coercion, upsert syntax)
- Index and query design for session lookup, credential verification, and API-key hashing paths
- Migration authoring and backward-compatible schema change sequencing
- Decoding query results through Schema at the repository boundary rather than trusting raw rows

## Hiring rubric

**Must demonstrate**
- Can explain why a query correct on Postgres silently broke on SQLite (or vice versa) and how to guard against it
- Wraps multi-statement writes in explicit transactions rather than relying on autocommit

**Strong signal**
- Has designed a repository migration that stays compatible with in-flight reads during rollout
- Profiles and indexes hot paths like session verification rather than accepting an unindexed lookup

**Red flags**
- Writes raw SQL string interpolation instead of parameterized queries or the query builder
- Assumes Postgres-only behavior (e.g., unquoted camelCase columns) without testing against SQLite

## Interview probes

- "The roles plugin needs to join a permissions table against a session lookup that's called on every request — how do you keep this query fast without denormalizing state qadi should own?"
- "Describe a bug you've hit where identical repository code behaved differently on Postgres vs SQLite."
- "How would you structure a repository migration that adds a NOT NULL column to a table with existing rows, without downtime?"
