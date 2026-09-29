---
ID: "TC-006"
Title: "direct/enterprise attestation accepted with nothing behind it"
Level: low
Category: "compliance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/WebAuthn.ts:74"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-006 — direct/enterprise attestation accepted with nothing behind it

`LOW` · `compliance` · `ports` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

## Summary

An operator can configure attestation: 'direct' or 'enterprise' and the ceremony will request attestation from authenticators, but no trust decision ever happens anywhere in the stack: verifyRegistration never validates the statement against trust anchors, there is no MDS3 integration (correctly deferred per BEH-EA-135), and AAGUID is consumed only by a 3-entry hardcoded label map (Passkey.ts:90-94). The scratch spec admits it: 'Enterprise attestation / FIDO MDS3 validation — config value accepted, nothing implemented behind it' (.scratch/passkey/spec.md:355-356). Requesting attestation from synced consumer passkeys is meaningless anyway — the risk is an enterprise adopter believing the flag buys verified-device identity. For an RP, the check that matters on the attestation object at v1 is: format 'none'/self-attestation accepted, AAGUID read for labeling, everything else ignorable — which is what the code does, just without saying so at the config site.

## Evidence

Source: `packages/ports/src/WebAuthn.ts:74`

```
/** BEH-EA-135: `"none"` is the default; `"direct"`/`"enterprise"` are explicit opt-in. */
export type AttestationConveyance = "none" | "direct" | "enterprise";
```

## Recommended fix

Either narrow AttestationConveyance to 'none' until the enterprise module exists, or emit a startup warning/doc note at the config site that direct/enterprise conveyance performs no trust validation in this version.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-004` — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag](medium/BPAS-004-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-002` — User-presence (UP) flag is never enforced in any ceremony](medium/CB-002-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-008` — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic](info/CB-008-christiaan-brand.md) `_(christiaan-brand, info)_`
- [`HSK-002` — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere](medium/HSK-002-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`
- [`HSK-006` — "indirect" attestation conveyance is absent from the type](info/HSK-006-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `webauthn-attestation-policy`. Duplicate of `HSK-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/WebAuthn.ts:73`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
