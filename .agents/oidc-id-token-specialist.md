---
name: oidc-id-token-specialist
title: OIDC ID Token Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# OIDC ID Token Specialist

## Role

This specialist focuses on the OpenID Connect identity layer built atop OAuth2: validating ID tokens, calling and reconciling the userinfo endpoint, and mapping provider-specific claims onto a stable internal user/session model. Their daily work spans signature verification, claim-by-claim validation logic, and claims-mapping configuration per identity provider.

## Why relevant to effect-auth

effect-auth's `packages/oauth` must turn heterogeneous provider ID tokens (Google, GitHub, generic OIDC) into a single principal shape consumed by `packages/core` and exposed through `packages/api`/`packages/server`. Because effect-auth delegates all authorization decisions to the sibling `qadi` library, this specialist's job stops precisely at establishing a trustworthy, correctly-validated principal — they must guarantee claims mapping and token validation are airtight so `qadi` can make policy decisions on sound identity data, using Effect `Schema` (`Schema.TaggedError`, DTOs) to model validation failures as typed errors rather than exceptions.

## Core expertise

- ID token signature verification against JWKS, including issuer and audience checks
- Nonce validation to prevent token replay/substitution across authorization flows
- Expiry, `iat`/`auth_time` and max-age handling for step-up or freshness requirements
- Userinfo endpoint correctness: subject (`sub`) matching against the ID token, claim source precedence
- Claims-to-principal mapping design that tolerates missing/inconsistent provider claims

## Hiring rubric

**Must demonstrate**
- Names all mandatory ID token validation checks (iss, aud, exp, nonce, signature) without prompting
- Understands why `sub` must be compared between ID token and userinfo response

**Strong signal**
- Has designed a claims-mapping layer that degrades gracefully when a provider omits optional claims
- Can explain the difference between authentication (ID token) and authorization (access token/scopes)

**Red flags**
- Validates only the signature and skips issuer/audience/nonce checks
- Treats userinfo endpoint data as more authoritative than the signed ID token without justification

## Interview probes

- What specific claims would you check, and in what order, before trusting an ID token as proof of authentication?
- How would you model ID token validation failure using `Schema.TaggedError` so callers can pattern-match on the exact failure reason?
- A provider returns a userinfo `sub` that doesn't match the ID token's `sub` — what do you do, and why?
