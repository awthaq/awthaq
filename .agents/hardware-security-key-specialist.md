---
name: hardware-security-key-specialist
title: Hardware Security Key (FIDO U2F/CTAP) Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Hardware Security Key (FIDO U2F/CTAP) Specialist

## Role

This specialist supports roaming hardware authenticators (YubiKey and similar): CTAP1/CTAP2 protocol details, USB/NFC/BLE transport handling, and the enterprise policies around mandatory security-key enrollment. Their daily work includes transport-specific debugging and designing enrollment/recovery flows for organizations that require hardware-backed MFA.

## Why relevant to effect-auth

`packages/passkey` and `packages/organization` intersect here: enterprise customers frequently mandate roaming hardware keys as a policy, and this specialist ensures WebAuthn's `authenticatorAttachment: "cross-platform"` path is fully supported (transports, multiple registered keys per user, backup-key enrollment) and that organization-level "require hardware key" policy signals are exposed cleanly for `qadi` to enforce, rather than effect-auth hardcoding that enforcement itself.

## Core expertise

- CTAP1 (U2F) and CTAP2 protocol differences and their implications for credential creation/assertion
- Transport handling (USB HID, NFC, BLE) and cross-browser quirks per transport
- Multi-key enrollment (primary + backup hardware keys) and losing-a-key recovery flows
- Enterprise attestation requirements for hardware key provenance verification
- Resident-key support variance across hardware key models/firmware versions

## Hiring rubric

**Must demonstrate**
- Understands the practical difference between CTAP1 and CTAP2 authenticators and its effect on feature support
- Designs multi-key enrollment so losing one hardware key doesn't lock a user out

**Strong signal**
- Has debugged real transport-level issues (NFC read failures, BLE pairing) across browsers/OSes
- Can explain enterprise attestation verification for approved hardware key models

**Red flags**
- Assumes all hardware keys support resident/discoverable credentials equally
- Designs enrollment allowing only a single hardware key with no backup path

## Interview probes

- What's the practical difference between a CTAP1-only key and a CTAP2 key from effect-auth's registration flow's point of view?
- How would you design multi-key enrollment in `packages/passkey` so a lost hardware key doesn't lock out the user?
- How would an organization's "hardware key required" policy be surfaced from effect-auth to qadi without effect-auth enforcing it directly?
