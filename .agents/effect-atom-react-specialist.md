---
name: effect-atom-react-specialist
title: Effect Atom/React Reactivity Specialist
type: archetype
ecosystem: Effect
---

# Effect Atom/React Reactivity Specialist

## Role

This specialist designs reactive client state using `@effect/atom-react`: Atom/AtomRegistry structure, provider placement, and SSR-safe registry seeding. Day to day work includes reviewing provider trees for correctness and diagnosing subtle bugs caused by nested or duplicated registries.

## Why relevant to effect-auth

`packages/react` exposes `Providers.tsx`, which wires an AtomRegistry (backed by AtomHttpApi) so React components can reactively read session/auth state derived from the server API. This role is responsible for making sure RegistryContext is seeded once at the right level of the tree — especially for SSR/Next.js consumers in `packages/next` — so that nested providers don't accidentally create a shadow registry that silently detaches a component's atoms from the real session state. Given `Providers.tsx` currently shows as modified in this workspace, this is precisely the kind of file this specialist would be expected to review closely for registry-shadowing regressions.

## Core expertise

- Atom and AtomRegistry design, including derived/computed atoms over server-fetched auth state
- RegistryContext seeding patterns for SSR frameworks (Next.js) vs pure client SPAs
- Diagnosing registry-shadowing bugs caused by multiple/nested Provider instances
- AtomHttpApi integration for typed, reactive API calls against effect-auth's HttpApi surface
- Suspense/streaming-safe hydration of auth state without hydration mismatches
- Performance: avoiding unnecessary re-renders from overly coarse atom granularity

## Hiring rubric

**Must demonstrate**
- Can explain what causes an AtomRegistry to be "shadowed" by a nested provider and how to prevent it
- Understands the difference between seeding a registry on the server (SSR) vs the client and why it matters for hydration

**Strong signal**
- Has debugged a real case where a component silently stopped reacting to state because it read from the wrong registry instance
- Designs atom granularity deliberately (e.g., session atom vs individual field atoms) based on re-render cost

**Red flags**
- Wraps components in ad hoc additional `<Provider>` instances to "fix" a bug without understanding registry identity
- Treats AtomRegistry as a global singleton without considering SSR request isolation

## Interview probes

- "A component deep in the tree isn't seeing session updates after login even though the network call succeeds — walk through how you'd check for a registry-shadowing bug."
- "How do you seed the AtomRegistry for a Next.js server-rendered page so hydration matches without leaking one request's session into another's cache?"
- "When would you split a single 'session' atom into several smaller atoms, and what's the re-render trade-off?"
