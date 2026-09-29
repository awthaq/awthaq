---
ID: "HSK-003"
Title: "Browser-reported transports are dropped at the API boundary, so the transports column is usually empty"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/PasskeyApi.ts:124"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-003 — Browser-reported transports are dropped at the API boundary, so the transports column is usually empty

`MEDIUM` · `dx` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **ready-for-agent**

## Summary

The registration credential schema accepts only clientDataJSON and attestationObject, and toRegistrationResponseJSON forwards exactly those two fields (Passkey.ts:147-150), so the browser's response.transports (from getTransports()) never reaches @simplewebauthn's verifyRegistrationResponse. verified.transports then falls back to authData extension output or the port's `?? []` (WebAuthn.ts:227), meaning real roaming-key enrollments persist transports:[] and every later excludeCredentials/allowCredentials descriptor (Passkey.ts:397,516) ships with no transport hint. For hardware keys this is exactly the transport-selection UX the persona debugs daily: browsers must probe every transport (USB/NFC/BLE/hybrid) instead of being told which to try, and the stored transports cannot power an admin's "which keys are NFC-capable" view. PasskeyCredentialDto also omits transports and aaguid from the client-facing list.

## Evidence

Source: `packages/passkey/src/PasskeyApi.ts:124`

```
export const AttestationResponseSchema = Schema.Struct({
  clientDataJSON: Schema.String,
  attestationObject: Schema.String,
```

## Recommended fix

Add `transports: Schema.optional(Schema.Array(Schema.String))` to AttestationResponseSchema, pass it through toRegistrationResponseJSON, and surface transports/aaguid in PasskeyCredentialDto.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AVS-003` — Untyped `Schema.Unknown` success contracts on passkey register-options endpoints](medium/AVS-003-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, medium)_`
- [`AVS-006` — Two spellings of the DELETE verb and four id conventions for destructive endpoints](low/AVS-006-api-design-versioning-specialist.md) `_(api-design-versioning-specialist, low)_`
- [`BPAS-009` — PasskeyCounterAnomaly declared in the contract but never raised by any endpoint](info/BPAS-009-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-wire-contract`. Evidence at HEAD ec065a7: `packages/passkey/src/PasskeyApi.ts:141`. Fix: Carry browser-reported transports end-to-end and surface transports/aaguid in the credential DTO. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
