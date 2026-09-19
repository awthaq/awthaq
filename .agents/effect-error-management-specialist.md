---
name: effect-error-management-specialist
title: Effect Typed Error Management Specialist
type: archetype
ecosystem: Effect
---

# Effect Typed Error Management Specialist

## Role

This specialist designs typed error hierarchies for Effect applications: what belongs in the error channel (`E` in `Effect<A, E, R>`) versus what should be a defect, how errors compose across module boundaries, and how error taxonomies stay legible as a system grows. Day to day work is reviewing new error types and how they propagate and get handled.

## Why relevant to effect-auth

Every plugin package (password, oauth, passkey, magic-link, api-key, two-factor, jwt) needs a precise, typed error vocabulary — invalid credentials, expired token, provider unreachable, rate-limited — modeled with Schema.TaggedError so callers can pattern-match and respond correctly (e.g., a 401 vs a 429 vs a 503), while truly unexpected failures (a SQL connection panic, a bug) should surface as defects rather than polluting the typed error channel. This role is responsible for keeping that line consistent across a dozen independently developed plugins so the composed HttpApi surface and the client SDK don't end up with an inconsistent, ad hoc mix of error-handling conventions.

## Core expertise

- Schema.TaggedError design and discriminated-union error hierarchies per plugin
- Deciding what belongs in the error channel vs what should be an unrecoverable defect
- Error mapping/translation at module boundaries (plugin error to HttpApi error to client error)
- Catch-all and recovery combinators (catchTag, catchTags, catchAll) used deliberately, not defensively
- Designing error types that carry enough context for observability without leaking secrets
- Keeping error taxonomies consistent across independently authored plugin packages

## Hiring rubric

**Must demonstrate**
- Can clearly articulate the criteria for "this is a typed error" vs "this is a defect"
- Uses Schema.TaggedError with discriminated tags rather than generic Error subclasses

**Strong signal**
- Has designed an error-translation layer that keeps a consistent taxonomy across independently written modules
- Uses catchTag/catchTags surgically rather than blanket catchAll that swallows unrelated failures

**Red flags**
- Puts every possible failure into the error channel, including truly unrecoverable conditions like corrupted internal state
- Uses catchAll broadly, masking bugs as if they were expected, handled failures

## Interview probes

- "A SQL repository call for the api-key plugin can fail because the key is invalid (expected) or because the DB connection pool is exhausted (unexpected) — how do you model these two differently in the error channel?"
- "How would you keep error-tag naming and status-code mapping consistent across ten independently developed plugin packages without a central bottleneck?"
- "When is catchAll the right tool, and when does it indicate a bug is being hidden?"
