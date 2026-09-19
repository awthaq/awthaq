---
name: effect-schema-specialist
title: Effect Schema Specialist
type: archetype
ecosystem: Effect
---

# Effect Schema Specialist

## Role

This specialist designs and maintains data contracts using Effect's Schema module: decoders/encoders, validation rules, branded fields, and typed error shapes. Day to day work includes modeling DTOs for API boundaries, reviewing schema diffs for backward compatibility, and deciding how strict a given boundary should be about unknown input.

## Why relevant to effect-auth

effect-auth's plugin packages (password, oauth, passkey, magic-link, api-key, two-factor, jwt) each define request/response DTOs and domain errors with Schema, and every SQL repository result must decode cleanly at the persistence boundary. Getting Schema.TaggedError hierarchies and struct/union modeling right directly determines whether a malformed OAuth callback or an expired magic-link token surfaces as a typed, catchable error instead of a defect. Schema evolution across plugin versions (e.g., adding a new two-factor method) also has to stay decode-compatible with data already persisted by the SQL repositories.

## Core expertise

- Schema.Struct/Union/TaggedError design, including exact-optional vs optional fields
- decode/encode round-tripping and transformation schemas (Schema.transform, Schema.transformOrFail)
- Branded and refined types for constrained primitives (emails, tokens, IDs)
- Schema versioning strategies for data already persisted in SQL repositories
- Annotations for OpenAPI/JSON Schema generation used by HttpApi contracts
- Property-based test generation from Schema (Arbitrary) for fuzzing decoders

## Hiring rubric

**Must demonstrate**
- Correct distinction between parse errors (typed) and truly unexpected failures (defects)
- Fluency with Schema.TaggedError and discriminated unions for error channels
- Understands why `as`/`as unknown as` casts defeat the purpose of a schema boundary

**Strong signal**
- Has designed a schema migration path that stays decode-compatible with old persisted rows
- Uses Schema.transformOrFail to encode validation logic rather than ad hoc checks post-decode

**Red flags**
- Reaches for `any`/type assertions to silence a decode mismatch instead of fixing the schema
- Treats Schema purely as a runtime validator and ignores the static type it derives

## Interview probes

- "A plugin needs to add a required field to a persisted session DTO without breaking rows written by the previous schema version — walk through your approach."
- "When would you model a failure as a Schema.TaggedError versus letting it become a defect?"
- "How would you fuzz-test a Schema-decoded OAuth token exchange response for malformed provider payloads?"
