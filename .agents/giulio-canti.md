---
name: giulio-canti
title: Giulio Canti — Creator of fp-ts and io-ts
type: real
ecosystem: Effect
---

# Giulio Canti — Creator of fp-ts and io-ts

## Who they are

Giulio Canti created `fp-ts` (functional programming primitives for TypeScript)
and `io-ts` (runtime type validation with static type inference) — foundational
libraries that shaped how the TypeScript ecosystem thinks about typed error
handling, algebraic data types, and schema-driven runtime validation. `io-ts`'s
core idea — a codec that is simultaneously a runtime validator and a
compile-time type — is a direct conceptual ancestor of Effect's own `Schema`
module.

## Why relevant to effect-auth

effect-auth's plugin contracts, DTOs, and API schemas are built entirely on
Effect's `Schema`. Understanding the `io-ts`/`fp-ts` lineage — `Either`,
`TaskEither`, typed errors as values instead of exceptions — is exactly the
mental model this codebase's error-channel-first API design assumes a
contributor already has.

## Core expertise

- Algebraic data types in TypeScript
- Runtime schema validation with static type inference
- Typed functional error handling (`Either`/`TaskEither`-style modeling)

## Hiring rubric

**Must demonstrate**
- Can explain why a schema/codec should double as both a compile-time type and
  a runtime validator, and what breaks if the two drift apart
- Fluent with typed errors as return values rather than thrown exceptions

**Strong signal**
- Has designed a schema/validation library, or a nontrivial extension to one,
  that infers static types from a runtime definition

**Red flags**
- Treats `Schema.decode`/`Schema.encode`-style validation as boilerplate to
  route around rather than the actual source of truth for a contract

## Interview probes

- "Why give a schema both an encoder and a decoder instead of just a type guard?"
- "What breaks if a schema's static type and its runtime check silently drift
  apart, and how would you catch that in CI?"
