---
name: event-sourcing-audit-trail-specialist
title: Event Sourcing & Audit Trail Specialist
type: archetype
ecosystem: Database & Persistence
---

# Event Sourcing & Audit Trail Specialist

## Role

This specialist models system state changes as an append-only sequence of immutable events rather than mutable rows, and builds the tooling to replay, audit, and reconstruct state from that log. Day to day work includes event schema versioning, snapshotting for replay performance, and building compliance-facing audit views from raw event streams.

## Why relevant to effect-auth

Auth systems generate an implicit event stream already — login attempts, credential rotations, session revocations, 2FA challenges, OAuth grants — scattered across effect-auth's plugin packages (`packages/password`, `packages/two-factor`, `packages/oauth`, `packages/api-key`). This specialist would formalize those as `AuthEvent` records in an append-only log backed by `packages/sql`, using Effect's `Schema` for versioned event contracts, enabling compliance audit trails and point-in-time replay for debugging incidents like "why did this session get revoked" without relying on mutable state that's already been overwritten.

## Core expertise

- Event schema design and versioning (upcasting old event shapes to current readers)
- Append-only log storage patterns and their indexing/query tradeoffs vs. mutable tables
- Snapshotting strategies to bound replay cost for long-lived aggregates (e.g., a user's full auth history)
- Building read-model projections from an event log for operational and compliance queries
- Idempotency and exactly-once semantics for event consumers

## Hiring rubric

**Must demonstrate**
- Can design an `AuthEvent` schema (e.g., `SessionCreated`, `CredentialRotated`, `TwoFactorChallenged`) with versioning built in from the start
- Understands the difference between an audit log (compliance, human-readable) and true event sourcing (event log as the sole source of truth)
- Knows how to bound replay cost with snapshots rather than replaying an unbounded event history every time

**Strong signal**
- Has built a compliance-facing audit trail from raw domain events and can describe how they handled event schema evolution over time
- Can articulate why auth events specifically need strong ordering and non-repudiation guarantees (e.g., can't silently drop a `SessionRevoked` event)

**Red flags**
- Treats "add an audit log table" and "event sourcing" as the same thing with no distinction in cost or guarantees
- No plan for schema evolution — assumes event shapes never change once written

## Interview probes

- "Design the `AuthEvent` schema for effect-auth using Effect's `Schema` module — what fields are non-negotiable, and how do you version it so a schema change doesn't break old events already in the log?"
- "A compliance auditor asks 'reconstruct exactly what this user's session state was at 3pm last Tuesday.' How does your event log answer that, and how fast?"
- "How would you guarantee an `AuthEvent` for a session revocation is never lost, even if the consumer that projects it into a read model crashes mid-processing?"
