---
ID: "HSK-006"
Title: "\"indirect\" attestation conveyance is absent from the type"
Level: info
Category: "api"
Status: resolved
Package: "ports"
Source: "packages/ports/src/WebAuthn.ts:73"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-006 — "indirect" attestation conveyance is absent from the type

`INFO` · `api` · `ports` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

AttestationConveyance offers only none|direct|enterprise. This matches BEH-EA-135's own spec text, but diverges from the WebAuthn L3 enum it wraps (which includes "indirect"); an RP that wants the browser to anonymize/strip identifying attestation while still opportunistically conveying model info for hardware-key analytics has no option, and future parity will be a type change in a public config shape. Purely an observation with the current no-verification posture (HSK-002); it matters more once attestation trust checking lands.

## Evidence

Source: `packages/ports/src/WebAuthn.ts:73`

```
/** BEH-EA-135: `"none"` is the default; `"direct"/"enterprise"` are explicit opt-in. */
```

## Recommended fix

Add "indirect" to AttestationConveyance (and to BEH-EA-135's text) when attestation policy work is scheduled; zero behavioral change today.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-004` — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag](medium/BPAS-004-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-002` — User-presence (UP) flag is never enforced in any ceremony](medium/CB-002-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-008` — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic](info/CB-008-christiaan-brand.md) `_(christiaan-brand, info)_`
- [`HSK-002` — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere](medium/HSK-002-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`
- [`TC-006` — direct/enterprise attestation accepted with nothing behind it](low/TC-006-tim-cappalli.md) `_(tim-cappalli, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `webauthn-attestation-policy`. Evidence at HEAD ec065a7: `packages/ports/src/WebAuthn.ts:73`. Fix: Add 'indirect' to AttestationConveyance. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** AttestationConveyance now includes 'indirect'; registrationOptions passes 'none' to the library for it and sets attestation:'indirect' on the returned options (no cast). Test: ports WebAuthn.test.ts 'HSK-006: registrationOptions with attestation indirect returns attestation indirect'. BEH-EA-135 updated. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
