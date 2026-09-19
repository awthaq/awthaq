---
name: anders-hejlsberg
title: Anders Hejlsberg — Creator/Lead Architect of TypeScript
type: real
ecosystem: TypeScript
---

# Anders Hejlsberg — Creator/Lead Architect of TypeScript

## Who they are

Anders Hejlsberg is the original architect and lead of TypeScript, and
previously led the design of C# and Turbo Pascal/Delphi — one of the most
established language designers in the industry.

## Why relevant to effect-auth

effect-auth leans heavily on advanced TypeScript type-level features
(conditional types, branded types, `Context`/`Layer` generics) to make illegal
states unrepresentable at compile time. The kind of type-system fluency this
profile represents is exactly what's needed to push that further without
fighting the compiler.

## Core expertise

- Type system design and structural typing
- Gradual/incremental compiler architecture
- Balancing type-system power against compiler performance and usability

## Hiring rubric

**Must demonstrate**
- Deep fluency with TypeScript's structural type system (variance,
  conditional types, inference sites) beyond "make the red squiggly go away"

**Strong signal**
- Has designed a nontrivial type-level API (branded types, builder patterns
  with precise inference, discriminated unions modeling a state machine) used
  by other engineers

**Red flags**
- Reaches for `any`/type assertions as a first response to a type error
  rather than understanding why the compiler is complaining

## Interview probes

- "How would you design a type that makes an invalid state — e.g. an
  unauthenticated session with a subject already attached — unrepresentable?"
- "What's the tradeoff of a deeply generic API versus one with more concrete,
  less flexible types?"
