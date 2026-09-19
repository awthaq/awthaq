---
name: timing-side-channel-specialist
title: Timing / Side-Channel Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Timing / Side-Channel Specialist

## Role

This specialist identifies and eliminates timing-based information leakage in security-sensitive comparisons and flows: non-constant-time secret comparison, and response-time differences that let an attacker infer whether a username, email, or API key exists without ever seeing an explicit error message. The work is detail-oriented, often involving microbenchmarking to confirm a leak is real and confirming a fix actually closes it.

## Why relevant to effect-auth

Nearly every effect-auth plugin performs a secret comparison or existence check that's a timing-side-channel candidate: password verification in `packages/password`, API-key lookup in `packages/api-key`, OTP comparison in `packages/two-factor`, and magic-link token validation in `packages/magic-link`. A specialist would check that these use constant-time comparison (not `===` on raw secret bytes) and that login/reset/OTP endpoints respond in statistically indistinguishable time regardless of whether the account or code exists, preventing user enumeration.

## Core expertise

- Constant-time comparison implementation and verification for password hashes, OTP codes, and API keys
- User-enumeration prevention via response-time normalization on login, password-reset, and OTP endpoints
- Statistical methodology for confirming a timing leak is real (not noise) and that a fix actually closes it
- Recognizing side-channel risk in early-return validation logic (e.g., checking "does this account exist" before "is the password correct")
- Broader side-channel awareness (cache-timing, error-message content) beyond pure response-time

## Hiring rubric

**Must demonstrate**
- Can explain why comparing secrets with `===`/standard string equality is unsafe and what constant-time comparison actually changes
- Understands how an early-return existence check ("no such user") creates a distinguishable response-time or response-content signal

**Strong signal**
- Has used statistical timing measurement to confirm a suspected leak was real before proposing a fix, rather than assuming
- Can identify enumeration risk in a flow that has no explicit "user not found" message but still leaks timing

**Red flags**
- Assumes removing the explicit "user not found" error message alone is sufficient to prevent enumeration
- Uses non-constant-time comparison for password hashes or OTP codes and considers it a non-issue because "it's just milliseconds"

## Interview probes

- Why is `crypto.timingSafeEqual`-style constant-time comparison necessary for OTP or API-key verification, and what's the actual exploit if you skip it?
- Design a login endpoint that responds in statistically indistinguishable time whether the account exists or not, including the case where the account exists but the password check would otherwise short-circuit.
- How would you verify, empirically, that a proposed timing fix actually closed the leak rather than just making it smaller?
