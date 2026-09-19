---
name: michael-arnaldi
title: Michael Arnaldi — Creator of Effect
type: real
ecosystem: Effect
---

# Michael Arnaldi — Creator of Effect

## Who they are

Michael Arnaldi is the creator of the Effect ecosystem for TypeScript (evolved from
his earlier "Matechs Effect" work into `effect-ts/effect`) and founder of Effectful
Technologies, the company stewarding Effect's ongoing development. Publicly known
for extensive writing, talks, and live-coding sessions on functional effect systems
in TypeScript, and for pushing Effect toward a more ergonomic, batteries-included
runtime — `Effect`, `Layer`, `Context`, `Schema`, and the `platform` packages this
repo depends on directly.

## Why relevant to effect-auth

effect-auth is built natively on Effect v4. Every design decision this codebase
makes — `Context.Service` for dependency injection, `Layer` composition for
plugins, `Schema.TaggedError` for typed failures, structured concurrency instead
of raw Promises — inherits directly from decisions this profile made about how
Effect should work. A hire at this level should be able to defend or challenge
those idioms from first principles, not just follow them by convention.

## Core expertise

- Effect runtime and fiber-based structured concurrency design
- `Layer`/`Context` dependency injection model
- Type-level TypeScript for library API design
- Building and stewarding a functional-effects ecosystem and company

## Hiring rubric

**Must demonstrate**
- Deep fluency in the `Layer`/`Context` model beyond copy-pasted boilerplate
- Can explain why Effect models cancellation and concurrency via fibers rather
  than `AbortController`/Promises
- Comfortable reading Effect's own source, not just consumer-facing docs

**Strong signal**
- Has contributed to or meaningfully extended a core Effect package
- Can articulate the tradeoffs of a typed error channel (`Effect<A, E, R>`)
  versus thrown exceptions, with concrete failure scenarios for each

**Red flags**
- Treats Effect as "a fancier Promise wrapper" with no grasp of fiber semantics
- Can't explain what problem a `Layer` solves that a plain constructor doesn't

## Interview probes

- "Walk through what happens when two `Layer`s both provide the same service
  with different implementations."
- "When would you reach for `Effect.gen` versus pipe-based composition, and why?"
- "How does Effect's approach to cancellation differ from `AbortController`,
  mechanically?"
