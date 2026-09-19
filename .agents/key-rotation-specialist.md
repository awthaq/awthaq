---
name: key-rotation-specialist
title: Key Rotation Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Key Rotation Specialist

## Role

This specialist designs zero-downtime rotation for cryptographic signing keys, ensuring that tokens signed under an old key remain verifiable during a transition window while new tokens adopt the new key immediately. The work centers on key identifier (`kid`) management, dual-key verification windows, and safe retirement of old keys once nothing in flight still depends on them.

## Why relevant to effect-auth

`packages/jwt` signs tokens whose verification must survive a signing-key rotation without invalidating every outstanding session or refresh token. A specialist would review whether tokens carry a `kid` (key ID) header so the verifier can select the correct historical public key, whether a rotation runbook exists that publishes the new key, waits out the maximum token lifetime, and only then retires the old key, and whether this coordinates correctly with the refresh-token rotation and revocation mechanisms elsewhere in the system.

## Core expertise

- Key ID (`kid`)-based multi-key verification so tokens signed under different keys remain verifiable during transition
- Dual-key (old + new) verification windows sized to the maximum outstanding token lifetime
- Key publication mechanisms (JWKS endpoints) and safe caching/refresh intervals for consumers
- Coordinating signing-key rotation with refresh-token rotation and session invalidation timing
- Emergency rotation procedures for suspected key compromise, distinct from routine scheduled rotation

## Hiring rubric

**Must demonstrate**
- Can explain why a rotation without a `kid`-based dual-key verification window breaks every outstanding token at the moment of rotation
- Understands the difference between routine scheduled rotation and emergency compromise-driven rotation, and why the latter can't wait out the normal grace window

**Strong signal**
- Has implemented or operated a JWKS-style multi-key verification endpoint with cache-refresh semantics for consumers
- Can size a rotation grace window correctly against actual token TTLs rather than picking an arbitrary duration

**Red flags**
- Proposes rotating a signing key by simply swapping it, invalidating every currently valid token instantly
- Has no distinct plan for emergency rotation under suspected compromise versus routine rotation

## Interview probes

- Design the rotation sequence for `packages/jwt`'s signing key so that tokens issued minutes before rotation remain verifiable, using `kid`-based key selection.
- How would emergency rotation differ from routine rotation if you suspected the current signing key had leaked? What do you sacrifice to move faster?
- If a downstream consumer caches your JWKS response, how do you ensure it picks up a new key before you retire the old one?
