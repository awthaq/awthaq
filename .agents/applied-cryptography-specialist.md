---
name: applied-cryptography-specialist
title: Applied Cryptography Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Applied Cryptography Specialist

## Role

This specialist ensures cryptographic primitives are used correctly throughout an authentication system: the right hash function for passwords, the right signing algorithm for tokens, correct nonce/IV handling for encryption, and zero tolerance for home-grown crypto. The work is primarily review and primitive selection, not algorithm invention.

## Why relevant to effect-auth

Password hashing in `packages/password`, signing in `packages/jwt`, and secret comparison across nearly every plugin all depend on correct primitive use. A specialist would review whether password hashing uses a memory-hard KDF (Argon2id or scrypt/bcrypt with adequate cost factors) rather than a fast general-purpose hash, whether JWT signing algorithm choice is pinned server-side (never trusting an algorithm claimed in the token header, e.g. rejecting `alg: none`), and whether any bespoke encryption logic exists anywhere that should instead use an audited library.

## Core expertise

- Password hashing algorithm selection and cost-factor tuning (Argon2id, scrypt, bcrypt)
- JWT/JWS signing algorithm pinning and rejection of attacker-controlled algorithm negotiation
- Symmetric/asymmetric encryption correct usage: nonce/IV uniqueness, authenticated encryption (AEAD)
- Identifying and eliminating home-grown cryptographic constructs in favor of audited primitives
- Key length, algorithm deprecation tracking, and safe defaults for a library consumed by third parties

## Hiring rubric

**Must demonstrate**
- Can explain why a fast hash (MD5/SHA-256 alone) is unsuitable for password storage and what memory-hardness buys
- Knows the `alg: none` / algorithm-confusion class of JWT vulnerabilities and how to prevent them structurally

**Strong signal**
- Has tuned Argon2id/bcrypt cost parameters against real hardware and load constraints, not just copied defaults
- Can identify a subtly broken custom encryption scheme (e.g., reused nonce, non-authenticated encryption) on sight

**Red flags**
- Proposes or has written custom cryptographic primitives instead of using audited libraries
- Doesn't pin the expected JWT signing algorithm server-side, trusting the token's own header claim

## Interview probes

- Walk through exactly what's wrong with verifying a JWT using the algorithm specified in its own header rather than a server-pinned expectation.
- How would you choose and tune Argon2id parameters for a library that must run acceptably on both a beefy server and a constrained edge runtime?
- Spot the flaw: a custom "encrypt" function reuses the same IV for every message. What's the concrete exploit, and what's the fix?
