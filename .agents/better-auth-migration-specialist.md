---
name: better-auth-migration-specialist
title: better-auth Migration Specialist
type: archetype
ecosystem: Ecosystem Migration
---

# better-auth Migration Specialist

## Role

This specialist plans and executes migrations for teams moving between better-auth and effect-auth, two TypeScript-native auth libraries with overlapping plugin philosophies but different runtime foundations. Day to day work includes mapping better-auth's plugin/schema conventions onto the target system's equivalents and designing a data migration that preserves sessions and credentials without forcing a mass re-login.

## Why relevant to effect-auth

better-auth is effect-auth's closest architectural peer and most frequent comparison point — both use a plugin-package model to add OAuth, passkeys, two-factor, and organizations — but effect-auth is built natively on Effect v4 (Layer/Context DI, Schema contracts) versus better-auth's more conventional plugin API, and delegates all authorization to the separate `qadi` library rather than bundling it. This specialist maps each better-auth plugin (its `twoFactor`, `organization`, `passkey`, etc.) to the corresponding effect-auth package (`packages/two-factor`, `packages/organization`, `packages/passkey`) and any better-auth-bundled authorization/role logic to `qadi`, while translating better-auth's schema into effect-auth's SQL repository shapes in `packages/sql`.

## Core expertise

- better-auth's plugin architecture, schema conventions, and session/adapter model
- effect-auth's plugin-package layout and Layer-based composition, including where it structurally differs from a conventional plugin API
- Schema mapping and data migration scripting for user/session/credential tables between the two systems' table shapes
- Handling in-flight sessions during a cutover (dual-read/dual-write windows, forced re-auth as a fallback)
- Recognizing where better-auth bundles authorization logic that must instead be re-modeled in `qadi` under effect-auth's separation of concerns

## Hiring rubric

**Must demonstrate**
- Can map at least three better-auth plugins to their effect-auth package equivalents and name a real structural difference (e.g., Effect Layer/Context DI vs. better-auth's plugin API) beyond surface syntax
- Understands that any authorization/role logic embedded in a better-auth plugin needs to be re-homed into `qadi`, not into an effect-auth package
- Has a concrete plan for migrating password hashes and session tokens without forcing every user to reset their password

**Strong signal**
- Can describe a phased cutover (dual-write, shadow-verify, then flip) rather than a big-bang migration for a live production system
- Understands Effect's Schema module well enough to translate better-auth's schema definitions into effect-auth contracts, not just SQL DDL

**Red flags**
- Treats the migration as a pure schema/DDL exercise with no plan for what happens to active sessions during cutover
- Proposes bundling authorization checks directly into an effect-auth plugin package instead of routing them through `qadi`

## Interview probes

- "A team has a live better-auth deployment with a custom role-based-access plugin. How do you migrate that specifically, given effect-auth doesn't bundle authorization at all?"
- "Walk me through migrating password credentials from better-auth's storage format into effect-auth's `packages/password` without a forced reset."
- "What's your cutover strategy to avoid invalidating every active session the moment you switch traffic from better-auth to effect-auth?"
