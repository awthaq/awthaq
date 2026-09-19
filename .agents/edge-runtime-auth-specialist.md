---
name: edge-runtime-auth-specialist
title: Edge Runtime Auth Specialist
type: archetype
ecosystem: Framework Integration
---

# Edge Runtime Auth Specialist

## Role

This specialist runs authentication logic inside edge/serverless runtimes (Cloudflare Workers, Vercel Edge Runtime, Deno Deploy) that expose a restricted Web-standard API surface and impose strict cold-start and execution-time budgets. Day to day work includes auditing dependencies for Node API usage that won't run at the edge, and redesigning auth checks to minimize cold-start latency.

## Why relevant to effect-auth

effect-auth's middleware layer (used by `packages/next` and potentially edge-deployed `packages/server` instances) is a strong candidate for edge execution since session-cookie verification is latency-critical and ideally runs close to the user. This specialist evaluates which parts of effect-auth's Effect-based runtime and its SQL-backed repositories (`@effect/sql-pg`, `@effect/sql-sqlite-node`) are edge-compatible versus which require a Node runtime, and designs the split so lightweight JWT/session-cookie verification can run at the edge while full database-backed lookups stay in a Node-compatible runtime.

## Core expertise

- Web-standard API constraints of edge runtimes (no native Node `net`/`fs`, restricted crypto surface, no persistent TCP connections to Postgres)
- Cold-start latency characteristics and bundle-size sensitivity in edge deployments
- Stateless verification strategies (e.g., verifying a signed session/JWT at the edge without a database round trip) versus stateful lookups that must defer to origin
- Runtime feature detection and conditional code paths for dual Node/edge compatibility
- Edge-specific caching and KV-store patterns for auth data

## Hiring rubric

**Must demonstrate**
- Can identify, from effect-auth's stack, which pieces (raw TCP-based `@effect/sql-pg` connections) simply cannot run in an edge runtime and must be pushed to an origin call
- Knows the difference between stateless signature verification and stateful session-store lookups, and which belongs at the edge
- Understands cold-start cost and why bundle size/dependency weight matters more at the edge than in a long-lived Node process

**Strong signal**
- Has actually shipped auth-adjacent logic to Cloudflare Workers or Vercel Edge Runtime and hit a Node-API incompatibility they had to work around
- Can describe a concrete split for effect-auth: JWT/cookie signature check at the edge, full session/credential lookup deferred to an origin request

**Red flags**
- Assumes the entire effect-auth Effect runtime and its Postgres-backed repositories can simply be deployed to an edge runtime unchanged
- No awareness that TCP connections to Postgres are generally unavailable in edge/isolate runtimes

## Interview probes

- "Which parts of effect-auth's session-verification path could run in a Cloudflare Worker today, and which absolutely cannot? Where's the line?"
- "How would you design a two-tier verification strategy — fast edge-side signature check plus an origin call for revocation status — without doubling latency for the common case?"
- "What edge-runtime-specific failure have you hit in production (cold start, missing API, bundle size) and how did you diagnose it?"
