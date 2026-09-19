---
name: react-server-components-auth-specialist
title: React Server Components Auth Specialist
type: archetype
ecosystem: Framework Integration
---

# React Server Components Auth Specialist

## Role

This specialist designs how authenticated state flows through a React Server Components architecture, ensuring session data is readable where needed on the server without ever serializing secrets into the client bundle. Day to day work includes drawing the hydration boundary correctly, auditing serialization of session objects across the server/client split, and structuring data-fetching so RSC and client components each get exactly the auth data they need.

## Why relevant to effect-auth

`packages/react` provides effect-auth's client-side reactive state via `AtomHttpApi`/`@effect/atom-react`, while session resolution itself happens server-side through Effect Layers. This specialist owns the seam between the two: making sure a Server Component can read the resolved subject/session directly (via the Effect runtime) without that data — tokens, credential internals — crossing into a Client Component's props, and ensuring `packages/react`'s providers (`Providers.tsx`) correctly hydrate only the minimal, public-safe subject shape needed for reactive client UI.

## Core expertise

- React Server Components serialization boundary: what can and cannot cross from server to client props
- Designing minimal, public-safe "session view" shapes distinct from the full server-side principal/session record
- Hydration mismatches between server-rendered auth state and client-side reactive atoms
- Context/provider design for auth state in a mixed RSC/client-component tree
- Streaming SSR considerations for auth-gated content (avoiding flash-of-unauthenticated-content)

## Hiring rubric

**Must demonstrate**
- Can explain precisely why passing a full session/credential object as a prop from a Server Component to a Client Component is a security bug, not just a style issue
- Understands the RSC serialization boundary (what Next.js/React actually allows to cross it) at a mechanical level
- Has designed or reviewed a "public session shape" distinct from the internal auth record

**Strong signal**
- Can describe how they'd design `packages/react`'s `Providers.tsx` to hydrate client atoms from a server-resolved session without leaking secret fields
- Has debugged a hydration mismatch caused by auth state differing between server render and client atom state

**Red flags**
- Proposes serializing the full session/JWT payload into a client component prop "for convenience"
- No distinction drawn between "authenticated" (server truth) and "appears authenticated" (client-rendered optimistic state)

## Interview probes

- "A Server Component resolves the full session object. What subset, if any, should ever reach a Client Component prop, and how do you enforce that boundary isn't accidentally widened later?"
- "How would you structure `packages/react`'s providers so a Client Component's reactive auth atom stays consistent with what the Server Component already knew at render time?"
- "Walk me through how you'd prevent a flash of unauthenticated content when a protected page streams before the session check resolves."
