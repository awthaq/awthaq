---
name: password-hashing-specialist
title: Password Hashing Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Password Hashing Specialist

## Role

This specialist selects and tunes password hashing parameters (argon2, bcrypt, scrypt), designs hash-format migration strategy as algorithms/parameters change over time, and ensures all comparisons are timing-safe. Their daily work includes benchmarking hashing cost against server load and planning transparent rehash-on-login migrations.

## Why relevant to effect-auth

`packages/password` is effect-auth's credential plugin, and this specialist owns its Argon2id (or equivalent) parameter selection, the versioned hash-format scheme needed to migrate users transparently when parameters change, and timing-safe comparison at the exact point credentials are verified — implemented as an Effect service so hashing cost (an inherently slow, blocking-ish operation) is properly modeled and doesn't stall the runtime's fiber scheduling.

## Core expertise

- Argon2id/bcrypt/scrypt parameter tuning (memory, iterations, parallelism) against real hardware/load
- Versioned hash formats enabling transparent rehash-on-successful-login migration
- Timing-safe comparison to prevent timing side-channel attacks on hash verification
- Pepper/secret-key-in-addition-to-salt strategies and their key management implications
- Modeling CPU/memory-bound hashing work correctly within an async/effectful runtime

## Hiring rubric

**Must demonstrate**
- Can justify specific argon2/bcrypt parameters against current hardware cost-to-crack estimates
- Knows why hash comparison must be constant-time and can name the underlying timing attack

**Strong signal**
- Has implemented a hash-format version tag enabling silent migration to stronger parameters over time
- Understands how to run CPU-bound hashing without starving an Effect runtime's fiber scheduler

**Red flags**
- Uses a fixed low iteration/memory cost "for performance" without acknowledging the security trade-off
- Compares hashes or plaintext secrets with standard `===`/string equality

## Interview probes

- Justify the specific argon2id parameters you'd pick for `packages/password` today, and how you'd revisit them in two years.
- How would you migrate existing users to stronger hash parameters without forcing a mass password reset?
- Where exactly would timing-safe comparison need to happen in the login verification path, and how would you model that as an Effect?
