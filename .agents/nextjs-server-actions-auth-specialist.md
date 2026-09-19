---
name: nextjs-server-actions-auth-specialist
title: Next.js Server Actions Auth Specialist
type: archetype
ecosystem: Framework Integration
---

# Next.js Server Actions Auth Specialist

## Role

This specialist integrates authentication flows into Next.js's App Router, specifically Server Actions and middleware, handling the cookie and request lifecycle quirks unique to that model. Day to day work includes wiring login/logout mutations through Server Actions, enforcing auth in middleware, and managing cookie propagation across the server/client boundary.

## Why relevant to effect-auth

`packages/next` is effect-auth's dedicated Next.js integration, and it must translate Effect-based session resolution into the App Router's request lifecycle: Server Actions run in a distinct execution context from middleware and from Route Handlers, each with different rules about when cookies can be set versus only read. This specialist ensures session cookie writes triggered by a Server Action (e.g., login) are correctly propagated so a subsequent Server Component render sees the new session, and that `packages/next` middleware correctly short-circuits unauthenticated requests before they reach protected routes.

## Core expertise

- Next.js App Router request lifecycle: Server Components, Server Actions, Route Handlers, and middleware, and their differing cookie-mutation rules
- Cookie propagation timing (why a cookie set in a Server Action isn't visible until the next navigation/response)
- Middleware-based route protection and its edge-runtime constraints
- Revalidation and cache interactions with auth state (avoiding stale cached pages showing another user's data)
- CSRF considerations specific to Server Actions

## Hiring rubric

**Must demonstrate**
- Can explain precisely why a cookie set inside a Server Action isn't immediately readable in the same render pass, and how to handle that UX gap
- Knows the difference in capabilities between middleware, Server Actions, and Route Handlers for auth enforcement
- Has implemented protected routes using Next.js middleware in production

**Strong signal**
- Can describe how they'd wire `packages/next`'s session resolution so it works identically whether invoked from middleware or a Server Action
- Understands the caching pitfalls of the App Router (e.g., a cached Server Component leaking one user's session-derived data to another)

**Red flags**
- Treats Server Actions like a client-side fetch with no awareness of their distinct cookie-write semantics
- Assumes middleware can do everything a Server Action or Route Handler can (e.g., full Node API access) despite edge runtime constraints

**Interview probes** heading below intentionally omitted here; see standard section.

## Interview probes

- "A user logs in via a Server Action. Why might the very next Server Component render on the same request not see the new session, and how do you fix it in `packages/next`?"
- "How would you structure middleware in `packages/next` to protect a route group without duplicating session-verification logic already in the Server Action layer?"
- "What's your strategy for preventing the Next.js full-route cache from serving one authenticated user's rendered page to a different user?"
