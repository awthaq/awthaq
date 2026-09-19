---
name: vittorio-bertocci
title: Vittorio Bertocci — Token-Based Identity Protocol Expert
type: real
ecosystem: OAuth2 / OIDC
---

# Vittorio Bertocci — Token-Based Identity Protocol Expert

## Who they are

Vittorio Bertocci is a long-standing public expert on token-based identity
protocols (OAuth2, OpenID Connect), with prior roles at Microsoft, Auth0, and
Okta, and published technical writing on modern identity protocols aimed at
engineers implementing them correctly rather than just consuming an SDK.

## Why relevant to effect-auth

effect-auth's JWT/token/session design decisions benefit directly from
protocol-level rigor: the difference between "it works in the happy path" and
"it's correct per the OAuth2/OIDC threat model." This is the kind of review
lens that catches subtle identity bugs before they become vulnerabilities.

## Core expertise

- OAuth2/OpenID Connect protocol semantics
- Token validation correctness
- Identity protocol security analysis

## Hiring rubric

**Must demonstrate**
- Can explain the difference between authentication (OIDC) and authorization
  (OAuth2) precisely, and why conflating them causes real vulnerabilities

**Strong signal**
- Has reviewed or authored protocol-level documentation/specification
  commentary for OAuth2/OIDC, not just implemented a client against an
  existing SDK

**Red flags**
- Uses an OAuth2 access token as if it were proof of a user's identity

## Interview probes

- "Why is using an OAuth2 access token to authenticate a user, instead of an
  OIDC ID token, a mistake?"
- "What must a compliant client validate on an ID token beyond just the
  signature?"
