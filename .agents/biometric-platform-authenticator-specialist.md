---
name: biometric-platform-authenticator-specialist
title: Biometric / Platform Authenticator Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Biometric / Platform Authenticator Specialist

## Role

This specialist focuses on platform authenticator UX — Face ID, Touch ID, Windows Hello — as surfaced through WebAuthn, and on the fallback flows required when biometrics are unavailable, disabled, or fail. Their daily work spans authenticator-selection UX, capability detection, and graceful degradation design.

## Why relevant to effect-auth

`packages/passkey` relies on the browser/OS platform authenticator for the common case, and this specialist ensures `packages/react` and `packages/next` surface correct, real-time capability detection (does this device support a platform authenticator, is it enrolled) and clean fallback paths — to a roaming key, magic link, or password — when biometrics fail, so the reactive client state managed via AtomHttpApi/`@effect/atom-react` reflects authenticator availability accurately rather than assuming success.

## Core expertise

- WebAuthn `authenticatorAttachment` and platform vs cross-platform authenticator selection
- Client-side capability detection (`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable`)
- Fallback flow design when biometric verification fails or is unavailable mid-flow
- UX sequencing for conditional UI / autofill-based passkey prompts
- Cross-OS/browser inconsistencies in platform authenticator behavior and error surfaces

## Hiring rubric

**Must demonstrate**
- Knows how to detect platform authenticator availability before prompting, avoiding a dead-end UX
- Designs a concrete fallback path (not just an error message) when biometric auth fails

**Strong signal**
- Has shipped conditional UI/autofill passkey flows across multiple browsers and handled their inconsistencies
- Treats "user cancelled biometric prompt" and "device has no platform authenticator" as distinct, differently-handled cases

**Red flags**
- Assumes all devices have a working platform authenticator and provides no fallback
- Surfaces raw WebAuthn `NotAllowedError`/`InvalidStateError` messages directly to end users

## Interview probes

- How would `packages/react` detect platform authenticator availability before rendering a "Sign in with Face ID" button?
- Design the fallback UX when a user's Windows Hello fails three times in a row.
- What's different in your handling between a user cancelling the OS biometric prompt versus the device having no authenticator at all?
