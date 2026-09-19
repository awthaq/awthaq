---
name: saml-federation-specialist
title: SAML Federation Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# SAML Federation Specialist

## Role

This specialist handles SAML-based enterprise SSO: validating SAML assertions, verifying XML digital signatures, and navigating the integration quirks of enterprise identity providers (Okta, Azure AD, PingFederate, ADFS). Day to day work includes metadata exchange, assertion consumer service (ACS) endpoint design, and troubleshooting IdP-specific deviations from the spec.

## Why relevant to effect-auth

Enterprise customers evaluating effect-auth alongside its OAuth/OIDC plugins (`packages/oauth`) will often require SAML federation for legacy IdPs; this specialist assesses whether and how a `packages/saml`-style plugin should be added to the existing plugin-package architecture, ensuring it produces the same principal shape consumed by `packages/core` and that XML signature verification is isolated behind a typed Effect service boundary rather than leaking XML parsing concerns into the rest of the runtime.

## Core expertise

- SAML 2.0 assertion structure, SP-initiated vs IdP-initiated flows
- XML digital signature (XML-DSig) verification and canonicalization pitfalls
- XML External Entity (XXE) and signature-wrapping attack prevention
- SP/IdP metadata exchange and certificate rotation handling
- Mapping SAML attribute statements to a normalized user/principal schema

## Hiring rubric

**Must demonstrate**
- Can explain XML signature wrapping attacks and how to prevent them
- Knows why XXE must be disabled in any XML parser used for SAML processing

**Strong signal**
- Has integrated with at least one enterprise IdP and handled its spec deviations firsthand
- Understands certificate rotation without service interruption (IdP metadata refresh)

**Red flags**
- Uses a generic XML parser without disabling external entity resolution
- Validates the assertion signature without validating the signed element is the one actually processed

## Interview probes

- Explain a signature-wrapping attack against SAML and the specific mitigation.
- How would you isolate XML parsing/signature verification behind an Effect service so the rest of effect-auth never touches raw XML?
- Walk through how you'd handle an IdP rotating its signing certificate without downtime.
