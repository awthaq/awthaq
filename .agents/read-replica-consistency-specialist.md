---
name: read-replica-consistency-specialist
title: Read Replica Consistency Specialist
type: archetype
ecosystem: Database & Persistence
---

# Read Replica Consistency Specialist

## Role

This specialist designs systems that scale reads across database replicas while managing the consistency gap introduced by replication lag. Day to day work includes choosing which queries are safe to route to replicas, designing read-your-writes guarantees, and instrumenting lag-aware fallback paths.

## Why relevant to effect-auth

effect-auth's session verification path (used by nearly every request across `packages/server`, `packages/next`, and `packages/api`) is acutely sensitive to replication lag: a user who just logged in or rotated a session token must not have that session appear invalid because a read hit a lagging Postgres replica. This specialist designs the routing rules inside the `@effect/sql-pg`-backed repositories in `packages/sql` so session writes and their immediate follow-up reads (login, session refresh, two-factor verification) are pinned to the primary while lower-stakes reads (e.g., organization membership listings) can safely use replicas.

## Core expertise

- Read-your-writes consistency patterns (primary pinning, session-token-based routing, causal read tokens)
- Postgres streaming replication and lag measurement (`pg_stat_replication`, WAL lag metrics)
- Designing fallback logic that detects stale reads and retries against the primary
- Classifying queries by staleness tolerance to decide replica eligibility
- Testing strategies for replication-lag-induced bugs (chaos/lag injection in staging)

## Hiring rubric

**Must demonstrate**
- Can explain concretely how a login-then-verify sequence breaks under naive round-robin read routing
- Knows at least one practical mechanism for read-your-writes guarantees (sticky primary reads, LSN/token-based read routing)
- Understands replication lag is variable, not a fixed constant, and designs for the tail not the average

**Strong signal**
- Has built or operated a system with mixed primary/replica routing and can describe a real incident caused by lag
- Can reason about which specific effect-auth flows (session creation, token refresh, 2FA challenge) require primary reads vs which tolerate replica staleness

**Red flags**
- Proposes routing all session reads to replicas "because reads scale better" without addressing the write-then-read window
- No plan for detecting or handling a stale read once it happens

## Interview probes

- "A user completes login, is immediately redirected, and their new session read hits a replica that hasn't caught up. How do you prevent this from producing a false 401?"
- "Which effect-auth reads would you confidently route to a replica, and which would you always pin to the primary? Justify each."
- "How would you instrument the system to detect when replica lag is causing session-verification failures in production, before users complain?"
