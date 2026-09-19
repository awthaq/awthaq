---
name: token-revocation-blacklist-specialist
title: Token Revocation & Blacklist Specialist
type: archetype
ecosystem: Session & Token Security
---

# Token Revocation & Blacklist Specialist

## Role

This specialist solves the structural tension of stateless tokens: once issued, a JWT is valid until expiry unless something actively tracks its revocation. The work involves designing denylist storage that scales with token volume, choosing propagation strategies across service instances, and minimizing the latency cost that revocation-checking adds to every authenticated request.

## Why relevant to effect-auth's own recent work

effect-auth's `packages/jwt` issues stateless tokens that need a revocation path, and the project's own recent commit ("request-scoped session-verify memoization") shows the team is already tuning the cost of per-request verification. A specialist here would evaluate whether that memoization is scoped correctly (per-request only, never leaking across requests or tenants) and whether the denylist/blacklist store used for revoked tokens or sessions imposes acceptable latency versus a positive-list session-store approach, particularly across the SQL repositories shared with `packages/organization` and `packages/admin`.

## Core expertise

- Denylist/blacklist storage design: TTL-bounded stores keyed by token ID or session ID
- Tradeoffs between stateless-token-plus-denylist and fully stateful sessions
- Request-scoped caching and memoization of verification results without introducing stale-trust windows
- Propagation of revocation across multiple service instances or edge/CDN layers
- Sizing and pruning strategies so a denylist doesn't grow unbounded

## Hiring rubric

**Must demonstrate**
- Can explain why a naive JWT scheme cannot support immediate logout without an additional revocation mechanism
- Understands the difference between caching a verification result for one request versus caching it across requests

**Strong signal**
- Has designed a denylist that self-prunes via the token's own expiry rather than requiring a separate cleanup job
- Can reason about the consistency window between "user revoked" and "all instances see the revocation"

**Red flags**
- Assumes a memoized "verified" result can be safely reused beyond the single request that produced it
- Proposes an unbounded blacklist with no expiry-based eviction

## Interview probes

- If verification results are cached per-request, what specific boundary must that cache never cross to avoid using stale trust decisions on a later request?
- Design a denylist store that supports O(1) revocation checks without growing indefinitely.
- How would you propagate an admin-triggered "revoke all sessions for this org" action across instances with acceptable latency?
