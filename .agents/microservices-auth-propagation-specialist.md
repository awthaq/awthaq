---
name: microservices-auth-propagation-specialist
title: Microservices Auth Propagation Specialist
type: archetype
ecosystem: Framework Integration
---

# Microservices Auth Propagation Specialist

## Role

This specialist designs how an authenticated principal's identity flows across internal service boundaries without forcing every downstream service to re-run full authentication. Day to day work includes designing internal token formats (signed JWTs, mTLS-based service identity), establishing service-to-service trust, and deciding what identity/claims data downstream services can trust versus must re-verify.

## Why relevant to effect-auth

Once effect-auth resolves a principal at the edge (via `packages/server` or `packages/next`), that principal often needs to reach internal services that don't have direct access to effect-auth's session store. This specialist designs the propagation contract — likely a short-lived signed JWT minted by `packages/jwt` after session resolution — that downstream services can verify cheaply (signature check) without querying the shared Postgres/SQLite-backed session store in `packages/sql` on every hop, while ensuring revocation (e.g., a session killed via `packages/admin`) is still respected within an acceptable propagation delay.

## Core expertise

- Internal token design: short-lived signed JWTs vs. opaque tokens requiring introspection, and the propagation-delay-vs-revocation-speed tradeoff
- Service-to-service trust models (mTLS, shared signing keys, a dedicated token-issuing service)
- Claims minimization: deciding what identity data is safe/necessary to embed in a propagated token versus fetched on demand
- Revocation propagation strategies when using self-contained signed tokens (short TTLs, revocation lists, event-driven invalidation)
- Zero-trust internal networking patterns as an alternative/complement to network-perimeter trust

## Hiring rubric

**Must demonstrate**
- Can articulate the fundamental tradeoff between self-contained signed tokens (fast, cheap to verify, but revocation-lagged) and introspection-based tokens (immediate revocation, but a network call per hop)
- Understands why re-running full effect-auth session resolution (a database hit) on every internal service hop doesn't scale
- Knows at least one concrete mechanism for propagating identity without re-authenticating (signed internal JWT, mTLS client cert with embedded identity)

**Strong signal**
- Has designed or operated an internal token-minting service and can describe its TTL and revocation strategy in detail
- Can explain how effect-auth's `packages/jwt` could mint a short-lived internal-propagation token distinct from the user-facing session token, with different claims and lifetime

**Red flags**
- Proposes passing the user's original long-lived session cookie/token directly to every downstream service unchanged
- No answer for how a revoked session (via `packages/admin`) gets enforced once a self-contained token has already propagated downstream

## Interview probes

- "A request authenticated at the edge needs to reach three internal services. How do you propagate identity without each one hitting the session store in `packages/sql` directly?"
- "An admin revokes a user's session via `packages/admin`. If you're using short-lived signed internal tokens for propagation, how long can that revocation take to fully take effect, and is that acceptable?"
- "What's the difference in claims and TTL you'd put in an internal service-to-service token minted by `packages/jwt` versus the user-facing session token?"
