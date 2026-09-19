---
name: developer-experience-sdk-specialist
title: Developer Experience / SDK Specialist
type: archetype
ecosystem: Developer Experience
---

# Developer Experience / SDK Specialist

## Role

This specialist designs the authoring experience for extending a system: how much boilerplate a new integration requires, how discoverable the extension points are, and how good the error messages and types are when someone gets it wrong. Day to day work is prototyping "what should this feel like to build" before optimizing internals.

## Why relevant to effect-auth

effect-auth's value proposition is largely about how easy it is to add a new plugin package (a new OAuth provider, a new two-factor method, a new admin capability) on top of the shared core, SQL repository patterns, and qadi-delegated authorization — and a runnable memory-backed example workspace already exists specifically to let a plugin author see minimal working wiring. This role owns minimizing the ceremony a new plugin needs (Layer wiring, Schema contract boilerplate, HttpApi registration) without sacrificing the type-safety and correctness guarantees the rest of the architecture depends on, and is the primary voice for "would a third-party plugin author actually enjoy building this."

## Core expertise

- Designing minimal-boilerplate scaffolding for new plugin packages (Layers, Schema DTOs, HttpApi groups)
- Evaluating and improving error messages/type errors surfaced when a plugin is wired incorrectly
- Building and maintaining example/reference workspaces that demonstrate correct plugin authoring
- Balancing ergonomic defaults against the "flexibility over complexity" principle — richer options over blanket simplification
- API discoverability: naming, module structure, and documentation that make the right usage obvious
- Gathering and acting on real friction reports from people building new plugins

## Hiring rubric

**Must demonstrate**
- Can identify concrete boilerplate in the current plugin-authoring flow and propose a reduction that doesn't erode type safety
- Understands the difference between removing genuine ceremony and removing configurability people actually need

**Strong signal**
- Has built or substantially improved an example/reference implementation that measurably reduced onboarding friction
- Prototypes the "what should this feel like" authoring experience before optimizing internal implementation details

**Red flags**
- Simplifies an API by removing configurability that real plugin authors depend on, purely to reduce surface area
- Ships DX improvements without validating them against an actual "write a new plugin from scratch" walkthrough

## Interview probes

- "Walk through, step by step, everything a developer must write to add a brand-new two-factor method today, and identify the one or two steps you'd cut first."
- "How do you decide whether a piece of plugin-authoring complexity is essential (reflects real configurability needs) versus accidental (just ceremony)?"
- "How would you validate that a proposed reduction in plugin boilerplate hasn't quietly made an important case impossible to express?"
