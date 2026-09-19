---
name: api-gateway-auth-specialist
title: API Gateway Auth Specialist
type: archetype
ecosystem: Framework Integration
---

# API Gateway Auth Specialist

## Role

This specialist decides where authentication enforcement lives in a distributed system — centralized at an API gateway versus duplicated per-service — and designs how an authenticated identity is communicated from the gateway to backend services via headers or signed context. Day to day work includes gateway policy configuration, header-based identity contracts, and drawing the line on what a gateway can validate versus what still needs service-level authorization.

## Why relevant to effect-auth

Many effect-auth deployments will sit behind an API gateway that terminates the user-facing session/cookie check once and forwards requests inward. This specialist decides whether effect-auth's session verification (via `packages/server` or `packages/api`) runs at the gateway itself or is delegated to individual services, and designs the trusted-header contract (e.g., `X-Auth-Subject`, `X-Auth-Claims`) backend services rely on — being explicit that authorization decisions still route to `qadi` inside each service rather than being shortcut at the gateway, since qadi (not effect-auth) owns authorization.

## Core expertise

- Centralized vs. distributed auth enforcement tradeoffs (single point of policy vs. defense-in-depth, single point of failure vs. duplicated logic)
- Trusted-header identity propagation design and the network-boundary trust assumptions it requires (spoofing prevention at the perimeter)
- Gateway-level rate limiting and auth-failure handling (distinguishing 401 vs 403 semantics consistently across services)
- Drawing the correct line between authentication (who is this — effect-auth's job) and authorization (what can they do — qadi's job) so the gateway doesn't accidentally absorb authorization logic
- mTLS or signed-request patterns for gateway-to-service trust so header-based identity can't be spoofed by bypassing the gateway

## Hiring rubric

**Must demonstrate**
- Can articulate the specific risk of trusted-header identity propagation (header spoofing if internal network isn't locked down) and how to close it
- Understands why centralizing authentication at a gateway is reasonable but centralizing authorization there is an architectural mistake given effect-auth's separation from qadi
- Has configured or reasoned about gateway-level auth policy in a real system (Kong, Envoy, AWS API Gateway, or custom)

**Strong signal**
- Can precisely describe the identity contract they'd design between a gateway running effect-auth's session verification and backend services that call into qadi for authorization
- Knows how to prevent internal services from being reachable directly (bypassing the gateway), which is required for header-based trust to be sound

**Red flags**
- Proposes moving authorization policy (qadi's responsibility) into the gateway layer for "performance," collapsing the authentication/authorization separation
- Assumes trusted headers are safe without addressing how internal traffic is locked down to prevent gateway bypass

## Interview probes

- "Where does session verification happen — at the gateway or in each service — and what identity contract (headers, signed token) do you pass downstream either way?"
- "How do you prevent a service from being called directly, bypassing the gateway, which would let an attacker forge the trusted identity headers?"
- "A team wants to add a coarse role check at the gateway to 'save a hop' to qadi. Why would you push back, given effect-auth's architecture?"
