---
name: christiaan-brand
title: Christiaan Brand — W3C WebAuthn Specification Co-editor
type: real
ecosystem: WebAuthn / Passkeys
---

# Christiaan Brand — W3C WebAuthn Specification Co-editor

## Who they are

Christiaan Brand has been publicly identified as a co-editor of the W3C Web
Authentication (WebAuthn) specification, working within Google's identity team
on passwordless authentication standards.

## Why relevant to effect-auth

As a specification co-editor, this profile represents the deepest possible
level of protocol correctness for effect-auth's passkey/WebAuthn
implementation — the difference between "works with the one authenticator I
tested" and "correct per spec across the whole authenticator ecosystem."

## Core expertise

- WebAuthn specification internals
- Ceremony correctness (registration/authentication options, challenge
  handling)
- Cross-vendor authenticator interoperability

## Hiring rubric

**Must demonstrate**
- Can explain the WebAuthn ceremony (challenge generation, client data JSON,
  attestation/assertion verification) at the level of the spec, not a
  library's abstraction of it

**Strong signal**
- Has implemented or reviewed a WebAuthn relying-party library against the
  raw specification, catching interoperability issues across authenticator
  vendors

**Red flags**
- Reuses challenges across ceremonies, or skips verifying the origin in
  `clientDataJSON`

## Interview probes

- "What exactly must a relying party verify in `clientDataJSON` beyond just
  parsing it?"
- "Why must the challenge be single-use and unpredictable?"
