---
name: bereket-engida
title: Bereket Engida — Creator of better-auth
type: real
ecosystem: better-auth
---

# Bereket Engida — Creator of better-auth

## Who they are

Bereket Engida is the creator of better-auth, a TypeScript-first authentication
and authorization framework designed to be framework-agnostic and deeply
extensible via a plugin system covering organizations, two-factor, passkeys,
API keys, admin, and more — one of the most direct prior-art comparisons for
effect-auth's own plugin architecture.

## Why relevant to effect-auth

effect-auth's plugin surface (organization, roles, admin, passkey, magic-link,
api-key, two-factor, oauth) covers close to the same feature space better-auth
popularized. Reading better-auth's plugin composition model is one of the
fastest ways to sanity-check whether effect-auth's Effect-native version is
missing a well-known feature or edge case its non-Effect counterpart already
handles.

## Core expertise

- Framework-agnostic authentication architecture
- Plugin-based extensibility for auth systems (schema, routes, client hooks)
- Developer-experience-first design for security-critical tooling

## Hiring rubric

**Must demonstrate**
- Can design a plugin system where each plugin extends the core schema, routes,
  and client hooks without the core needing to know about the plugin in advance

**Strong signal**
- Has shipped or meaningfully contributed a plugin to a plugin-based auth
  framework (better-auth, Auth.js, a Passport strategy)

**Red flags**
- Hardcodes plugin-specific logic into the framework core "just this once"

## Interview probes

- "How would you let a passkey plugin add columns to the core user table
  without the core package knowing passkeys exist?"
- "What's the hardest part of keeping a plugin's client-side hooks in sync
  with its server-side routes as the plugin evolves?"
