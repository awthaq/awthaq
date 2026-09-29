---
ID: "CB-002"
Title: "User-presence (UP) flag is never enforced in any ceremony"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/WebAuthn.ts:212"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-002 — User-presence (UP) flag is never enforced in any ceremony

`MEDIUM` · `security` · `ports` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **ready-for-agent**

## Summary

The port disables the library's UP check for every registration (SimpleWebAuthn v14 skips `flags.up` when `requireUserPresence: false`), and `verifyAuthenticationResponse` has no UP check at all — so UP enforcement is entirely the plugin's job per the port's own header. The plugin never reads a userPresent value: it only inspects `userVerified` (Passkey.ts:477, 574-578). Consequently only the conditional-create path was designed to tolerate UP=0/UV=0, but nothing structurally prevents an ordinary registration or an assertion from being accepted with UP=0 as long as UV=1, and conditional registrations accept UP=0 by consumption-path alone. WebAuthn §7.1 requires verifying user presence for every ceremony except conditional ones.

## Evidence

Source: `packages/ports/src/WebAuthn.ts:212`

```
requireUserPresence: false,
requireUserVerification: false,
```

## Recommended fix

Expose `userPresent` on VerifiedRegistration/VerifiedAuthentication alongside `userVerified`, enforce UP=1 in the plugin for ordinary registration and authentication, and reserve the UP=0 allowance for challenges consumed from the conditional scope.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: WebAuthn ceremonies
- Full dossier: [`christiaan-brand`](../../.reports/christiaan-brand/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-004` — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag](medium/BPAS-004-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-008` — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic](info/CB-008-christiaan-brand.md) `_(christiaan-brand, info)_`
- [`HSK-002` — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere](medium/HSK-002-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`
- [`HSK-006` — "indirect" attestation conveyance is absent from the type](info/HSK-006-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-006` — direct/enterprise attestation accepted with nothing behind it](low/TC-006-tim-cappalli.md) `_(tim-cappalli, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `webauthn-user-presence`. Evidence at HEAD ec065a7: `packages/ports/src/WebAuthn.ts:204`. Fix: Enforce UP on ordinary registrations by letting the plugin choose requireUserPresence per ceremony; surface userPresent. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
