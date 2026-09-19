---
name: balazs-orban
title: Balázs Orbán — Lead Maintainer, Auth.js
type: real
ecosystem: Auth.js
---

# Balázs Orbán — Lead Maintainer, Auth.js

## Who they are

Balázs Orbán is a lead maintainer of Auth.js (the successor project to
NextAuth.js), steering its evolution into a framework-agnostic authentication
toolkit spanning Next.js, SvelteKit, and other frameworks.

## Why relevant to effect-auth

Auth.js's multi-framework adapter layer — one core auth engine, multiple thin
framework integrations — is the same shape effect-auth's `@awthaq/next` package
(and any future framework adapters) needs to follow to stay framework-agnostic
at its core.

## Core expertise

- Multi-framework auth SDK design
- Maintaining a high-traffic open-source security library
- Migration and versioning strategy for breaking auth changes

## Hiring rubric

**Must demonstrate**
- Can design one auth core with thin, idiomatic adapters per framework (Next.js
  App Router, SvelteKit, etc.) without leaking framework-specific concerns into
  the core

**Strong signal**
- Has maintained or significantly contributed to a multi-framework SDK and
  handled a major breaking migration for it

**Red flags**
- Designs the framework adapter first and reverse-engineers the "core" from
  it, baking in framework assumptions that later block other adapters

## Interview probes

- "What belongs in a framework adapter versus the core auth engine?"
- "How do you version a breaking change to a session cookie format without
  logging every existing user out?"
