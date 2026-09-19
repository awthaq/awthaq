---
name: effect-concurrency-fiber-specialist
title: Effect Concurrency & Fiber Specialist
type: archetype
ecosystem: Effect
---

# Effect Concurrency & Fiber Specialist

## Role

This specialist reasons about structured concurrency in Effect: fiber forking and supervision, interruption semantics, STM for shared mutable state, and Queue/Semaphore-based coordination primitives. The daily work is designing concurrent workflows that are safe under cancellation and don't leak fibers or resources.

## Why relevant to effect-auth

Authentication systems have inherently concurrent hot paths — verifying a session on every request, coalescing duplicate concurrent token-refresh attempts, rate-limiting login and OTP-verification attempts per account, and safely retrying OAuth token exchanges. A recent ticket added request-scoped session-verify memoization, which is exactly the kind of Fiber/Ref/Deferred coordination this role owns: ensuring concurrent requests for the same session within a window share one verification effect rather than issuing duplicate SQL repository calls or provider calls. This role also designs Semaphore-backed rate limiting for two-factor and password plugins and STM-based coordination where multiple fibers must observe consistent state without lock-style bugs.

## Core expertise

- Fiber forking, joining, interruption, and supervision strategies (Effect.fork, Fiber.join, Scope)
- STM (TRef, STM.retry) for coordinating shared state without races
- Queue and Semaphore design for rate limiting, request coalescing, and backpressure
- Deferred/Ref patterns for memoizing in-flight effects (e.g., session-verify memoization)
- Reasoning about interruption safety in resource-acquiring code paths
- Diagnosing fiber leaks and deadlocks in production-like load tests

## Hiring rubric

**Must demonstrate**
- Can explain the difference between fiber interruption and exception propagation, and why it matters for cleanup
- Has implemented request coalescing or memoization for a hot, concurrently-invoked effect

**Strong signal**
- Has used STM correctly to avoid a race that a naive Ref-based approach would have introduced
- Can reason precisely about what happens to in-flight fibers when a parent scope closes early

**Red flags**
- Reaches for ad hoc mutable module state or manual locks instead of Effect's concurrency primitives
- Can't explain why unbounded Effect.forEach with concurrency: "unbounded" is dangerous on a login endpoint

## Interview probes

- "Two concurrent requests hit session-verify for the same session ID within the same tick — how do you make sure only one SQL lookup happens, and how do errors propagate to both callers?"
- "How would you rate-limit two-factor code verification attempts per account using Effect's primitives, including what happens under interruption?"
- "Describe a fiber leak you've diagnosed in production and how you found it."
