---
name: tim-smart
title: Tim Smart — Effect Platform & Infrastructure Maintainer
type: real
ecosystem: Effect
---

# Tim Smart — Effect Platform & Infrastructure Maintainer

## Who they are

Tim Smart is a core maintainer within the Effect organization, publicly credited
across many `effect-ts/effect` platform-adjacent packages — HTTP client/server,
RPC, sockets, and related infrastructure modules. Known in the community for
high-velocity contributions that turn Effect's core primitives into practical,
production-usable platform packages.

## Why relevant to effect-auth

effect-auth's HTTP layer, RPC-shaped APIs, and platform integration are built
directly on `@effect/platform`-style packages — the same catalog-pinned
dependencies (`@effect/platform-node`, `@effect/sql-*`) this repo tracks exactly
against `effect`'s own RC version. Anyone touching `AuthHttp`, `AtomHttpApi`, or
this repo's SQL packages needs the kind of platform-internals fluency this
profile represents.

## Core expertise

- Effect platform packages: HTTP client/server, sockets, RPC
- Turning core Effect primitives into ergonomic, runtime-agnostic library surfaces
- TypeScript library API design at production scale

## Hiring rubric

**Must demonstrate**
- Can design a `Layer`-based HTTP client/server abstraction that composes
  cleanly with dependency injection
- Understands why platform packages stay runtime-agnostic (Node vs browser vs
  edge) rather than baking in one runtime's assumptions

**Strong signal**
- Has built or meaningfully extended a platform-style package (an HTTP client,
  a protocol implementation) on top of Effect's core primitives

**Red flags**
- Builds HTTP integrations that bypass `Layer`/`Context` with ad hoc singletons
  or module-level mutable state

## Interview probes

- "How would you design a platform-agnostic HTTP client `Layer` so Node and
  browser runtimes can each provide their own implementation?"
- "Why keep transport concerns out of a core Effect package rather than baking
  in `node:http` directly?"
