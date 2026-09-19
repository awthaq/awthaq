---
name: effect-testing-vitest-specialist
title: Effect Testing & @effect/vitest Specialist
type: archetype
ecosystem: Effect
---

# Effect Testing & @effect/vitest Specialist

## Role

This specialist writes and maintains the test suite for an Effect application using `@effect/vitest`: effectful test cases, TestClock-driven time control, and property-based testing via Schema Arbitraries. Day to day work is making concurrent and time-dependent code deterministically testable.

## Why relevant to effect-auth

Auth flows are full of time- and concurrency-sensitive behavior — session expiry, magic-link TTLs, two-factor code windows, rate-limit backoff, and the newly added request-scoped session-verify memoization — all of which need deterministic tests rather than real sleeps or flaky timing assertions. This role is responsible for the unit/integration test layer beneath the `features/` Gherkin/BDD suite, using `@effect/vitest`'s `it.effect`/`it.live` and TestClock to advance virtual time and assert exact expiry and coalescing behavior, and for providing test Layers that swap real SQL repositories and qadi authorization for in-memory fakes.

## Core expertise

- `@effect/vitest` test constructs (it.effect, it.scoped, it.live) and Layer provisioning in tests
- TestClock for deterministic testing of expiry, TTLs, and scheduled/retry logic
- Property-based testing of Schema-decoded inputs via fast-check/Arbitrary integration
- Building fake/in-memory Layers for SQL repositories and qadi authorization for fast unit tests
- Testing concurrent code paths (fiber interleaving, race conditions) deterministically
- Coordinating unit-test coverage with the Gherkin/BDD acceptance suite so responsibilities don't overlap

## Hiring rubric

**Must demonstrate**
- Can write a TestClock-based test that asserts session expiry without any real elapsed time
- Knows how to provide a fake Layer to isolate a unit under test from real SQL/network dependencies

**Strong signal**
- Has caught a real race condition using deterministic fiber-interleaving tests rather than flaky sleep-based tests
- Designs property-based tests from a Schema definition rather than hand-writing example inputs only

**Red flags**
- Uses real `setTimeout`/sleep-based waits in tests for time-dependent auth logic
- Duplicates the Gherkin/BDD acceptance scenarios as unit tests instead of testing at the right layer

## Interview probes

- "How would you test that a magic-link token expires exactly at its TTL boundary, without the test taking real wall-clock time?"
- "Write a test strategy for the request-scoped session-verify memoization ticket — what needs a fake Layer, and what needs TestClock?"
- "Where's the line between what belongs in the `features/` Gherkin suite and what belongs in an `@effect/vitest` unit test?"
