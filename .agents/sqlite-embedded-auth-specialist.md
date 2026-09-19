---
name: sqlite-embedded-auth-specialist
title: SQLite Embedded Auth Specialist
type: archetype
ecosystem: Database & Persistence
---

# SQLite Embedded Auth Specialist

## Role

This specialist designs authentication persistence for embedded, single-node, or edge-adjacent deployments where SQLite replaces a client-server database. Day to day work covers single-writer concurrency management, file-based durability (WAL mode, checkpointing), and scoping which auth features are practical without a networked database.

## Why relevant to effect-auth

effect-auth ships a runnable, memory-backed example workspace and supports `@effect/sql-sqlite-node` as a persistence backend in `packages/sql`, making SQLite a first-class option for self-hosted or embedded deployments rather than just a test double. This specialist evaluates which effect-auth plugins (e.g., `packages/two-factor`, `packages/api-key`) behave safely under SQLite's single-writer model and identifies where write contention could serialize otherwise-concurrent auth flows like simultaneous session refreshes.

## Core expertise

- SQLite WAL mode, checkpointing, and durability tradeoffs for write-heavy workloads
- Single-writer concurrency: serializing writes without starving read throughput
- Embedded/edge deployment patterns (single binary, co-located database file, backup/restore of a live file)
- Scoping feature sets appropriately for embedded deployments (e.g., what breaks without a shared network database across replicas)
- Migrating an embedded SQLite deployment to a networked Postgres backend without a rewrite

## Hiring rubric

**Must demonstrate**
- Understands why SQLite's single-writer model means concurrent session writes serialize, and can estimate the practical throughput ceiling
- Knows WAL mode configuration and its effect on reader/writer concurrency
- Can explain the constraints on horizontally scaling an app that keeps auth state in a local SQLite file

**Strong signal**
- Has actually run an auth workload against embedded SQLite and diagnosed a `SQLITE_BUSY` under load
- Can design a migration path from SQLite to Postgres that doesn't require rewriting plugin-level repository code, exploiting a shared `@effect/sql` interface

**Red flags**
- Assumes SQLite behaves like Postgres under concurrent writes with no caveats
- Recommends SQLite for a multi-instance horizontally-scaled deployment without flagging the shared-state problem

## Interview probes

- "The memory-backed example workspace needs to become a real single-node deployment backed by SQLite. What changes about session write throughput, and how would you validate it?"
- "Two processes try to write a new session row at the same instant against the same SQLite file. Walk me through what happens and how you'd avoid a `SQLITE_BUSY` failure surfacing to the user."
- "How would you structure the `@effect/sql` repository layer so switching from SQLite to Postgres later doesn't require touching plugin package code?"
