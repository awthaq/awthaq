---
name: webauthn-passkeys-specialist
title: WebAuthn/Passkeys Implementation Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# WebAuthn/Passkeys Implementation Specialist

## Role

This specialist implements the WebAuthn registration and authentication ceremonies end to end: challenge generation, attestation verification, and credential (public key) storage. Their daily work includes handling resident/discoverable keys, cross-platform authenticator quirks, and keeping the ceremony spec-compliant across browsers.

## Why relevant to effect-auth

`packages/passkey` is effect-auth's dedicated WebAuthn plugin, and this specialist owns its registration/authentication ceremony implementation, attestation statement verification, and resident-key (discoverable credential) handling so passwordless sign-in produces the same principal shape consumed by `packages/core`; they also ensure the ceremony's challenge lifecycle is modeled as Effect-managed, time-bounded state persisted via the SQL repositories rather than ad hoc session storage.

## Core expertise

- WebAuthn registration/authentication ceremony (challenge, clientDataJSON, attestationObject/assertion)
- Attestation statement formats and verification (packed, fido-u2f, none) and when to require attestation
- Resident/discoverable credential handling for usernameless sign-in
- Public key credential storage schema (credential ID, public key, sign counter, transports)
- Cross-browser/platform quirks and graceful degradation when WebAuthn is unsupported

## Hiring rubric

**Must demonstrate**
- Can explain the full registration ceremony data flow from challenge to stored public key
- Knows why the signature counter must be checked and updated to detect cloned authenticators

**Strong signal**
- Has implemented resident-key/discoverable-credential flows for usernameless login, not just second-factor WebAuthn
- Understands attestation trust trade-offs (when to verify attestation chains vs. accept `none`)

**Red flags**
- Skips signature counter validation, missing cloned-authenticator detection
- Treats WebAuthn credential IDs as safe to use as primary user identifiers without additional binding

## Interview probes

- Walk through what effect-auth's `packages/passkey` must verify between receiving the client's assertion and calling it a successful authentication.
- How would you model the WebAuthn challenge as short-lived, Effect-managed state so it can't be replayed or reused across sessions?
- When would you require attestation verification versus accepting `none`, and what does effect-auth gain or lose either way?
