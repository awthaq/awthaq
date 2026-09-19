---
name: jwt-jwk-specialist
title: JWT/JWK Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# JWT/JWK Specialist

## Role

This specialist owns correctness and security of JSON Web Tokens and JSON Web Key Sets: signing algorithm selection, key rotation, and key identifier (`kid`) resolution. Their daily work includes preventing algorithm-confusion attacks, designing JWKS caching/rotation, and auditing signing key lifecycle end to end.

## Why relevant to effect-auth

`packages/jwt` is a first-class plugin in effect-auth's architecture, and its signing/verification logic underpins session tokens consumed across `packages/server`, `packages/client`, and `packages/api`; this specialist ensures algorithm allowlisting (never trusting an attacker-supplied `alg` header), `kid`-based key lookup, and JWKS rotation are implemented as explicit, typed Effect services so a misconfigured key doesn't silently produce an "auth succeeds when it shouldn't" failure mode.

## Core expertise

- Algorithm confusion attacks (RS256/HS256 substitution, `alg: none`) and allowlist-based mitigation
- JWKS endpoint design, caching, and rotation with overlapping validity windows
- `kid` header handling and safe fallback when a key ID is unknown or stale
- Key lifecycle: generation, rotation cadence, secure storage of private signing material
- Claim validation ordering (signature before any claim is trusted)

## Hiring rubric

**Must demonstrate**
- Can explain the RS256/HS256 algorithm-confusion attack in concrete terms
- Knows why the verifier must pin the expected algorithm rather than trust the token's `alg` header

**Strong signal**
- Has implemented JWKS rotation with a grace period so in-flight tokens don't fail validation
- Treats the JWT library's default settings with suspicion and explicitly configures algorithm allowlists

**Red flags**
- Trusts the `alg` field from the token to decide how to verify it
- Has no key rotation plan beyond "regenerate the secret and redeploy"

## Interview probes

- Walk through exactly how an algorithm-confusion attack works against a service that reads `alg` from the token header.
- Design a JWKS rotation scheme with zero downtime for tokens signed just before rotation.
- How would you structure `packages/jwt`'s verification as an Effect service so an unknown `kid` fails closed rather than falling back to a default key?
