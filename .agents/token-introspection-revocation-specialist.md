---
name: token-introspection-revocation-specialist
title: Token Introspection & Revocation Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# Token Introspection & Revocation Specialist

## Role

This specialist designs token lifecycle infrastructure: RFC 7662 introspection endpoints for opaque or stateful tokens, revocation endpoints, and the propagation mechanisms that keep distributed services consistent about a token's live/dead status. Their daily work includes cache invalidation strategy, revocation list design, and latency/consistency trade-offs.

## Why relevant to effect-auth

effect-auth's `packages/jwt` and session model must answer "is this token/session still valid" consistently across every consuming plugin (`packages/api`, `packages/server`, `packages/client`); this specialist owns the introspection/revocation surface and the recently-added request-scoped session-verify memoization (see the "upstream-hardening-followups" work), ensuring memoized verification never masks a revocation that happened mid-request, and that revocation propagates correctly across SQL-backed persistence in `packages/sql`.

## Core expertise

- RFC 7662 token introspection endpoint semantics and authorization for introspection callers
- RFC 7009 token revocation and cascading revocation (refresh token revokes descendant access tokens)
- Stateless JWT revocation strategies (deny-lists, short expiry + refresh, key rotation as revocation)
- Cache/memoization invalidation correctness under concurrent revocation events
- Distributed consistency trade-offs: eventual vs strong consistency for "is this token dead"

## Hiring rubric

**Must demonstrate**
- Can explain the fundamental tension between stateless JWTs and instant revocation
- Knows the difference between introspection (a query) and revocation (a mutation) endpoints and their distinct authz requirements

**Strong signal**
- Has designed a request-scoped memoization layer that is provably safe against stale revocation results
- Understands cascading revocation semantics (revoking a refresh token must kill derived access tokens)

**Red flags**
- Assumes memoizing a session-verify call within a request is always safe without checking for revocation race conditions
- Builds revocation as a fire-and-forget notification with no propagation guarantee

## Interview probes

- effect-auth just added request-scoped session-verify memoization — what invariant must hold for that to be safe if a revocation happens concurrently?
- How would you implement revocation for a stateless JWT-based session without turning every request into a database hit?
- Design an introspection endpoint's authorization model — who's allowed to ask "is this token valid," and why does that matter?
