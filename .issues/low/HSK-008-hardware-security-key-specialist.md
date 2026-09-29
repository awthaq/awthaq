---
ID: "HSK-008"
Title: "No test coverage for direct/enterprise attestation, transports, or cross-platform attachment"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/test/passkeyTestFixtures.ts:65"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-008 — No test coverage for direct/enterprise attestation, transports, or cross-platform attachment

`LOW` · `testing` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **ready-for-agent**

## Summary

The only real-cryptography tests are packages/ports/test/WebAuthn.test.ts, and its fixtures build exclusively "none"-attestation responses (webauthnFixtures.ts:126 explicitly notes no attestation signature is constructed) with an all-zero AAGUID; plugin-level tests mock the port outright (attestationObject:"" throughout Passkey.test.ts). Consequence: none of the hardware-key-relevant behavior this persona owns — attestation statement handling under direct/enterprise, transports propagation into options and persistence, AAGUID extraction/labeling, authenticatorAttachment plumbing, non-zero counters through recordUsage — is exercised by any test. Regressions in exactly the fields the credential record exists to carry would land silently.

## Evidence

Source: `packages/passkey/test/passkeyTestFixtures.ts:65`

```
counter: 0,
        aaguid: "00000000-0000-0000-0000-000000000000",
        transports: [],
```

## Recommended fix

Extend webauthnFixtures with a packed-attestation (self-attestation) builder and non-zero AAGUID/transports, add port tests for options-echo and verified-output of transports/aaguid, and add one plugin test asserting a real-shaped registration persists non-empty transports and a named AAGUID label.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `passkey-wire-contract`. Evidence at HEAD ec065a7: `packages/passkey/test/passkeyTestFixtures.ts:60`. Fix: Add real-shaped fixtures (packed self-attestation, non-zero AAGUID, transports) and end-to-end plugin tests over the real port. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
