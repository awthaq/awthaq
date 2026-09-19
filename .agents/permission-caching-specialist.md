---
name: permission-caching-specialist
title: Permission Caching Specialist
type: archetype
ecosystem: Authorization
---

# Permission Caching Specialist

## Role

This specialist designs caching layers for authorization decisions, balancing the performance win of not recomputing a permission check against the security risk of acting on a stale decision. The work includes choosing cache keys and TTLs, designing invalidation triggers tied to role/permission changes, and quantifying acceptable staleness windows per decision type.

## Why relevant to effect-auth

Since qadi owns authorization decisions while effect-auth supplies the underlying facts (roles from `packages/roles`, org membership from `packages/organization`), any caching of permission decisions must be invalidated precisely when those underlying facts change — a role revoked in `packages/roles` must not remain effective in a stale qadi decision cache. A specialist would review whether effect-auth emits change events (via its AuthEvents mechanism in `packages/core`) that a caching layer can subscribe to for invalidation, rather than relying on TTL expiry alone for security-sensitive changes like role revocation or org removal.

## Core expertise

- Cache key design for authorization decisions (subject + resource + action + context version)
- Event-driven cache invalidation tied to the actual mutation of roles/permissions, not just TTL
- Staleness risk analysis: which decisions tolerate seconds of staleness and which (e.g., access revocation) must be immediate
- Negative-result caching pitfalls (caching a "denied" decision that should become "allowed" quickly)
- Multi-instance cache coherence for authorization decisions (local cache vs shared cache vs pub/sub invalidation)

## Hiring rubric

**Must demonstrate**
- Can explain why TTL-only caching is unsafe for a revocation-sensitive permission decision
- Understands the asymmetry between caching an "allow" too long (security risk) and caching a "deny" too long (availability annoyance)

**Strong signal**
- Has built an event-driven invalidation path from a mutation (role change, membership removal) to a permission cache
- Can articulate different staleness budgets for different decision classes in the same system

**Red flags**
- Proposes a single global TTL for all cached authorization decisions regardless of sensitivity
- Has no invalidation strategy beyond "the cache will expire eventually"

## Interview probes

- If effect-auth emits an AuthEvent when a user's role is revoked, how would you wire that into an authorization decision cache to guarantee the revocation takes effect on the very next request?
- Which permission decisions in a system like this would you refuse to cache at all, and why?
- Design a cache invalidation strategy that works correctly across multiple running instances without requiring them to share a single in-memory cache.
