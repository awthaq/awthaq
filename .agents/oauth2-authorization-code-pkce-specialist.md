---
name: oauth2-authorization-code-pkce-specialist
title: OAuth2 Authorization Code + PKCE Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# OAuth2 Authorization Code + PKCE Specialist

## Role

This specialist owns correct implementation of the OAuth2 authorization code grant, including PKCE for both public (SPA, mobile, CLI) and confidential (server-side) clients. Day to day work includes designing the redirect/callback flow, generating and validating code verifiers/challenges, wiring state and nonce parameters, and hardening against open-redirect and code-interception attacks.

## Why relevant to effect-auth

effect-auth's `packages/oauth` implements provider integrations (authorization code flows against Google, GitHub, and similar IdPs) that must be correct across effect-auth's client surfaces — `packages/server`, `packages/client`, `packages/react`, and `packages/next` — each with different confidentiality guarantees. Because sessions, tokens, and callback state are threaded through Effect's `Layer`/`Context` DI and persisted via SQL repositories in `packages/sql`, this specialist must ensure PKCE verifiers and `state` are stored and validated inside that same effectful, typed pipeline rather than in ad hoc mutable globals.

## Core expertise

- RFC 6749 authorization code grant and RFC 7636 PKCE (S256 vs plain, verifier entropy requirements)
- Public vs confidential client threat models and redirect URI validation
- CSRF-resistant `state` parameter design and correlation with server-held session data
- Authorization server metadata discovery (RFC 8414) and dynamic client registration awareness
- Secure storage/expiry of short-lived authorization codes and one-time verifiers

## Hiring rubric

**Must demonstrate**
- Can explain why PKCE is mandatory for public clients and still valuable for confidential ones
- Knows the exact failure mode of skipping `state` validation (CSRF via authorization code injection)

**Strong signal**
- Has debugged real-world redirect URI mismatch or code-reuse incidents
- Understands how to bind PKCE verifiers to a typed, effectful session store rather than cookies alone

**Red flags**
- Suggests storing the PKCE verifier client-side in plaintext localStorage without justification
- Treats `state` and `nonce` (OIDC) as interchangeable

## Interview probes

- Walk through what happens if an attacker intercepts the authorization code but not the PKCE verifier.
- How would you structure PKCE verifier storage as an Effect `Layer` so it composes with a request-scoped session service?
- What redirect URI validation rules would you enforce, and why is substring matching insufficient?
