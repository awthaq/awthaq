---
name: mattia-manzati
title: Mattia Manzati — Effect Developer Tooling
type: real
ecosystem: Effect
---

# Mattia Manzati — Effect Developer Tooling

## Who they are

Mattia Manzati is publicly associated with Effect's developer-tooling side,
notably `@effect/language-service` — the TypeScript language service plugin that
provides Effect-specific diagnostics and refactors directly in the editor and
build pipeline.

## Why relevant to effect-auth

This repo treats `@effect/language-service` diagnostics as build-breaking errors
(see the "promote language-service warnings to error" hardening ticket in this
repo's history). That is exactly the tool this profile represents — including
the "duplicate package" diagnostic that caught a real `effect`/`@qadi` version-skew
regression during this repo's rc.116 dependency upgrade, before it ever reached
runtime.

## Core expertise

- TypeScript compiler API and language-service plugin architecture
- Static analysis tooling for Effect-specific idioms
- Developer tooling UX (diagnostics that are actionable, not just noisy)

## Hiring rubric

**Must demonstrate**
- Comfort writing TypeScript language-service plugins or compiler-API
  transforms, not just consuming ones someone else wrote
- Understands why a duplicate-package diagnostic exists and which real
  invariant it protects (type identity across two copies of one dependency)

**Strong signal**
- Has written or debugged a custom TS language-service plugin, ESLint/oxlint
  rule, or `ts-morph`/compiler-API-based tool

**Red flags**
- Suppresses static-analysis diagnostics (`allowedDuplicatedPackages`,
  blanket `// @ts-expect-error`) as a first resort instead of a last one

## Interview probes

- "How would you implement a check that detects two versions of the same npm
  package resolving inside one TypeScript program?"
- "What's the tradeoff of shipping an Effect-specific check as a language-service
  plugin versus a standalone lint rule?"
