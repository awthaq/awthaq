---
name: typescript-type-level-engineer
title: TypeScript Type-Level Engineer
type: archetype
ecosystem: Developer Experience
---

# TypeScript Type-Level Engineer

## Role

This specialist works at the type level of TypeScript: branded types, conditional and mapped types, and encoding domain invariants so illegal states are unrepresentable rather than merely checked at runtime. Day to day work includes reviewing type signatures for soundness and tightening APIs so misuse fails to compile.

## Why relevant to effect-auth

effect-auth's plugin architecture relies on precise types to keep a session, credential, or token from being used in the wrong state — an unverified two-factor challenge shouldn't type-check where a verified session is expected, and a raw string shouldn't be usable as a hashed password or a signed JWT without going through the right constructor. This role is directly responsible for enforcing the project's hard "no type assertions" rule (`as`/`as unknown as`/`as any` forbidden in library source) by finding the type-level design — branded types, discriminated unions, conditional types on plugin Layer composition — that makes the assertion unnecessary in the first place.

## Core expertise

- Branded/nominal types for distinguishing raw vs validated/hashed/signed values (tokens, hashes, IDs)
- Discriminated unions that make illegal state combinations (e.g., unverified-but-active session) unrepresentable
- Conditional and mapped types for plugin composition APIs that adapt to what a Layer provides
- Diagnosing and eliminating type assertions by restructuring the type, not suppressing the checker
- Generic inference design so consumer code gets precise types without manual type arguments
- Reading and improving `tsc -b` project-reference boundaries as they affect cross-package type inference

## Hiring rubric

**Must demonstrate**
- Can redesign a type that "needed" an assertion into one that doesn't, without weakening runtime safety
- Understands branded types well enough to prevent a raw string from being used as a hashed credential

**Strong signal**
- Has made a real illegal state (e.g., "verified" and "expired" simultaneously true) unrepresentable via the type system
- Writes generic APIs whose inferred types stay precise for consumers without requiring manual annotations

**Red flags**
- Reaches for `as unknown as X` to resolve a type error under deadline pressure rather than fixing the model
- Adds return-type annotations to work around inference issues instead of fixing the underlying generic signature

## Interview probes

- "A password-hashing function's output and a raw password string both type as `string` today — how would you use branding to make it impossible to pass a raw password where a hash is expected?"
- "You find `as unknown as SessionData` in a PR. Walk through how you'd redesign the surrounding types to remove it."
- "How would you encode 'a two-factor challenge must be verified before a session can be finalized' so the compiler rejects the wrong order?"
