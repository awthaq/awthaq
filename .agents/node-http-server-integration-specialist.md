---
name: node-http-server-integration-specialist
title: Node HTTP Server Integration Specialist
type: archetype
ecosystem: Framework Integration
---

# Node HTTP Server Integration Specialist

## Role

This specialist wires authentication middleware into raw Node HTTP servers and Express/Fastify-style frameworks, handling request/response lifecycle details like header parsing, cookie serialization, and middleware ordering. Day to day work includes adapting a framework-agnostic auth core to a specific server's request/response objects and ensuring performance under the framework's concurrency model.

## Why relevant to effect-auth

`packages/server` is effect-auth's framework-agnostic HTTP integration point, meant to sit in front of a raw Node HTTP server or common frameworks without forcing consumers into `packages/next`. This specialist ensures the Effect-based request handling — where auth logic runs inside `Effect` computations backed by Layers — bridges cleanly to Node's callback/stream-based `IncomingMessage`/`ServerResponse` model or a framework's middleware chain, correctly propagating cookies, headers, and error responses without breaking Effect's structured concurrency and interruption model.

## Core expertise

- Node.js `http`/`https` module internals: headers, streaming bodies, connection lifecycle
- Adapting middleware-chain frameworks (Express, Fastify, Koa) to a different concurrency/effect model
- Cookie serialization and header manipulation across different framework request/response abstractions
- Running Effect-based async logic inside a Promise/callback-based server runtime without breaking interruption semantics
- Performance characteristics of different Node HTTP server models under concurrent auth-checking load

## Hiring rubric

**Must demonstrate**
- Can explain how to bridge an `Effect`-based auth check into an Express middleware or raw `http.Server` request handler without losing error propagation or interruption behavior
- Understands the difference between Express's middleware chain, Fastify's hook system, and a raw Node HTTP server, and how each affects where auth checks are inserted
- Knows how to correctly set/read cookies across these different abstractions

**Strong signal**
- Has built a framework adapter layer before (translating a framework-agnostic core into multiple server frameworks) and can describe the abstraction boundary they chose
- Can reason about backpressure/streaming implications when an auth check needs to read a request body before framework-level body parsing runs

**Red flags**
- Treats all Node frameworks as interchangeable with no awareness of middleware ordering or hook-timing differences
- Runs Effect programs via `runPromise` inside a hot request path without considering the cost of spinning up a runtime per request

## Interview probes

- "How would you adapt `packages/server`'s Effect-based session verification to run as Express middleware, Fastify hook, and raw Node `http.Server` handler, sharing as much logic as possible?"
- "A framework's body parser runs before your auth middleware and consumes the request stream. How does that affect an auth flow that needs to read the raw body, and how do you fix the ordering?"
- "What's your strategy for running an Effect program per incoming request without incurring runtime-construction overhead on every request?"
