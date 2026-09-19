---
name: totp-hotp-mfa-specialist
title: TOTP/HOTP MFA Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# TOTP/HOTP MFA Specialist

## Role

This specialist implements time-based and counter-based one-time password MFA: secret provisioning (including QR code enrollment), code validation windows, and clock-drift/counter-desync tolerance. Their daily work covers RFC 6238/4226 compliance and the enrollment UX that gets a shared secret safely onto a user's authenticator app.

## Why relevant to effect-auth

`packages/two-factor` implements this exact mechanism for effect-auth, and this specialist owns its clock-drift tolerance window, replay protection (rejecting a reused TOTP code within its validity window), and QR-code-based secret provisioning flow, ensuring the shared secret is generated and stored via the same SQL-backed, typed repository pattern used elsewhere in the codebase rather than as an untyped string field.

## Core expertise

- RFC 6238 (TOTP) and RFC 4226 (HOTP) algorithm correctness, including step size and digit count
- Clock-drift tolerance windows (accepting adjacent time steps) without widening the replay attack surface
- Replay protection: rejecting a previously-used code within its validity window
- Secret provisioning via QR code (otpauth:// URI format) and manual entry fallback
- HOTP counter desync recovery when client and server counters drift

## Hiring rubric

**Must demonstrate**
- Can state the correct clock-drift tolerance trade-off (usually ±1 step) and why widening it further is risky
- Knows that a validated TOTP code must be marked used to prevent replay within its window

**Strong signal**
- Has implemented HOTP counter resynchronization (look-ahead window) for hardware tokens
- Treats the shared secret as sensitive at rest (encrypted, not just base32-encoded in the clear)

**Red flags**
- Allows unlimited clock-drift tolerance to "fix" user complaints about failed codes
- Does not track used codes, allowing replay within the same time step

## Interview probes

- What's your exact clock-drift tolerance policy for TOTP validation in `packages/two-factor`, and what's the security cost of widening it?
- How do you prevent a valid TOTP code from being replayed twice within the same 30-second window?
- Walk through the otpauth:// URI you'd generate for QR enrollment and what happens if the secret leaks during that step.
