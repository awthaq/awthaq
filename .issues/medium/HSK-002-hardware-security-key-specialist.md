---
ID: "HSK-002"
Title: "Attestation conveyance (\"direct\"/\"enterprise\") exists but attestation is never verified anywhere"
Level: medium
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/WebAuthn.ts:74"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-002 — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere

`MEDIUM` · `security` · `ports` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

An operator who sets attestation:"direct" or "enterprise" to enforce hardware-key provenance (the core enterprise use case this persona serves) gets attestation statements conveyed by the authenticator, but verifyRegistrationResponse is called with only challenge/origin/rpId expectations (WebAuthn.ts:207-214) — there is no FIDO MDS lookup, no approved-AAGUID allow-list, and no trust-anchor policy anywhere in the repo (grep for attestation/aaguid in packages/qadi and packages/organization returns nothing). The three-entry KNOWN_AAGUID_LABELS table (Passkey.ts:90-94) is cosmetic labeling only. BEH-EA-135's text honestly defers MDS to a future enterprise module, but the config knob is live today and silently promises provenance it cannot check: any authenticator, including a synced software passkey, is enrolled identically under "enterprise".

## Evidence

Source: `packages/ports/src/WebAuthn.ts:74`

```
export type AttestationConveyance = "none" | "direct" | "enterprise";
```

## Recommended fix

Either fail closed when attestation != "none" is configured and no verification policy is supplied, or add an optional port hook (verifyAttestation/trustedAaguids) so an operator can enforce an approved-hardware-model list; at minimum document on PasskeyConfigShape.attestation that conveyance does not imply verification.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-004` — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag](medium/BPAS-004-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-002` — User-presence (UP) flag is never enforced in any ceremony](medium/CB-002-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-008` — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic](info/CB-008-christiaan-brand.md) `_(christiaan-brand, info)_`
- [`HSK-006` — "indirect" attestation conveyance is absent from the type](info/HSK-006-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-006` — direct/enterprise attestation accepted with nothing behind it](low/TC-006-tim-cappalli.md) `_(tim-cappalli, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `webauthn-attestation-policy`. Evidence at HEAD ec065a7: `packages/ports/src/WebAuthn.ts:73`. Fix: (Recommended option B) Surface attestation format and add an optional AAGUID/format trust policy; warn when conveyance is requested without a policy. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan; user may revisit. Port surfaces attestationFormat and attestationType (none|self|certificate, classified from the verified attestation object); PasskeyConfig.attestationPolicy { trustedAaguids, rejectSelfAttestation? (default true) } makes register/verify fail PasskeyAttestationRejected (new 400 error) for no attestation, self-attestation, or an unlisted AAGUID; Passkey.layer warns once at build when attestation != 'none' and no policy is set. Optional attestationRootCertificates forwarding (dossier step 3) deliberately not built: it is process-global in the library; documented in AttestationPolicy JSDoc, README and BEH-EA-135 that this is an allow-list, not MDS3. Tests: PasskeyAttestation.test.ts (none rejected, listed certificate accepted case-insensitively, unlisted rejected, self rejected/accepted, warning emitted exactly once / not with policy), PasskeyRealPort.test.ts (real packed self-attestation accepted with policy; none rejected), ports WebAuthn.test.ts (format/type surfaced). Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
