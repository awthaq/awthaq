---
name: pilcrow
title: "pilcrow (pilcrowOnPaper) — Creator of Lucia Auth"
type: real
ecosystem: Lucia Auth
---

# pilcrow (pilcrowOnPaper) — Creator of Lucia Auth

## Who they are

Known publicly by the handle "pilcrow" (pilcrowOnPaper), creator of Lucia Auth
and a prominent educator on implementing authentication from first principles
in TypeScript rather than depending on an opaque framework — publishing
detailed, protocol-level guides on sessions, OAuth, and password hashing.

## Why relevant to effect-auth

effect-auth is itself a from-first-principles, Effect-native auth runtime
rather than a wrapper around an existing service. This profile's public thesis
— understand and own your auth primitives instead of treating them as a black
box — is close to effect-auth's own design philosophy, and directly useful
when reviewing whether a session/password implementation is actually correct
rather than just "looks right."

## Core expertise

- Session-based auth implementation details (validation, rotation, invalidation)
- Password hashing correctness
- OAuth client implementation built directly from the protocol spec
- Teaching security-critical code clearly and precisely

## Hiring rubric

**Must demonstrate**
- Can implement session validation, rotation, and invalidation correctly from
  scratch, explaining every step's security purpose

**Strong signal**
- Has written or taught an auth-from-scratch guide/library that other
  engineers used to learn the underlying protocols, not just consumed a
  framework

**Red flags**
- Can call a session library's API but can't explain what "session rotation"
  is actually defending against

## Interview probes

- "Walk through exactly what happens, step by step, when a session is
  validated on each request."
- "Why rotate a session ID on privilege escalation (e.g. login), specifically?"
