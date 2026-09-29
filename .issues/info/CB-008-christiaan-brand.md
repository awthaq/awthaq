---
ID: "CB-008"
Title: "direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic"
Level: info
Category: "compliance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/WebAuthn.ts:109"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-008 — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic

`INFO` · `compliance` · `ports` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

`PasskeyConfig.attestation` accepts "direct"/"enterprise" (BEH-EA-135) and the port forwards `attestationType`, so the library will verify attStmt syntax. But VerifiedRegistration/VerifiedAuthentication expose only aaguid/deviceType/backup flags — no attestation format, trust path, or verification verdict — and no FIDO MDS integration exists anywhere in the repo. An operator opting into "enterprise" gets nothing they can enforce: no AAGUID allow-list against metadata, no trust-anchor matching. BEH-EA-135 explicitly defers MDS to a future enterprise module, so this is a documented v1 boundary rather than a bug — but nothing at the config knob warns the operator that the conveyed policy is inert beyond the request string.

## Evidence

Source: `packages/ports/src/WebAuthn.ts:109`

```
export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: Uint8Array_;
```

## Recommended fix

Either surface `fmt`/trust-path fields on VerifiedRegistration so downstream enterprise code has something to consume, or document on `PasskeyConfigShape.attestation` that direct/enterprise currently verify statement syntax only and require the deferred MDS module for trust decisions.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: WebAuthn ceremonies
- Full dossier: [`christiaan-brand`](../../.reports/christiaan-brand/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-004` — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag](medium/BPAS-004-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-002` — User-presence (UP) flag is never enforced in any ceremony](medium/CB-002-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`HSK-002` — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere](medium/HSK-002-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`
- [`HSK-006` — "indirect" attestation conveyance is absent from the type](info/HSK-006-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-006` — direct/enterprise attestation accepted with nothing behind it](low/TC-006-tim-cappalli.md) `_(tim-cappalli, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `webauthn-attestation-policy`. Duplicate of `HSK-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/WebAuthn.ts:109`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `HSK-002-hardware-security-key-specialist` — closed by its fix (see that issue's Resolved comment).
