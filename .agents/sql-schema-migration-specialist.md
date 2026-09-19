---
name: sql-schema-migration-specialist
title: SQL Schema Migration Specialist
type: archetype
ecosystem: Database & Persistence
---

# SQL Schema Migration Specialist

## Role

This specialist designs and executes schema changes for production databases without incurring downtime or breaking in-flight application code. Day to day work includes writing expand/contract migration sequences, backfilling columns safely under load, and coordinating deploy ordering between schema changes and application releases.

## Why relevant to effect-auth

effect-auth's persistence layer spans SQL repositories built on `@effect/sql-pg` and `@effect/sql-sqlite-node`, with auth-critical tables (sessions, credentials, two-factor secrets, API keys) shared across plugin packages (`packages/password`, `packages/two-factor`, `packages/api-key`, `packages/jwt`). Because plugins are composed independently via Effect Layers, a schema change to a shared table like `session` or `user` must not break packages that weren't redeployed at the same time. This specialist ensures migrations for `packages/sql` stay backward compatible across the plugin boundary.

## Core expertise

- Expand/contract (parallel-change) migration patterns for additive and destructive schema changes
- Online index creation and constraint validation without table locks
- Backfill strategies with batching, throttling, and resumability
- Multi-version compatibility: writing migrations that tolerate old and new application code running simultaneously
- Migration tooling (e.g., versioned SQL files, checksums, idempotent re-runs)
- Rollback and forward-fix planning for failed migrations

## Hiring rubric

**Must demonstrate**
- Can articulate the expand/contract pattern from memory with a concrete auth-table example (e.g., renaming a `user.email` column)
- Understands why `ADD COLUMN ... NOT NULL DEFAULT` can lock a large table and knows the safe alternative
- Has shipped a migration in production that required a multi-deploy sequence

**Strong signal**
- Has designed migrations that survive a plugin architecture where consumers deploy on independent schedules
- Can explain how to migrate a composite/foreign-key relationship (e.g., session-to-user) without an availability gap

**Red flags**
- Proposes single-step destructive migrations ("just drop and recreate the column") for production auth tables
- No answer for what happens if a migration fails halfway through a backfill

## Interview probes

- "Session tokens need a new `revoked_at` column with a default. Walk me through the exact migration steps for a table with 50M rows under continuous write load."
- "How would you migrate the `user` table's primary key type without breaking sessions created by the old code during the rollout?"
- "How do you version and coordinate SQL migrations across independently-versioned plugin packages that all read the same `credential` table?"
