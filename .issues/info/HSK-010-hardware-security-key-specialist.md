---
ID: "HSK-010"
Title: "Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual"
Level: info
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:104"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-010 — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual

`INFO` · `security` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

layerMemory and layerSql compare the presented challenge to the stored value with plain string equality, while the same file implements constantTimeEqual for its HMAC cookie path (line 235). Exploitability is effectively nil — the value is 256 bits of CSPRNG output, popped unconditionally so an attacker gets exactly one timing sample per issued challenge, and the sample is over a JS string compare — so this is an inconsistency observation, not a vulnerability. It is worth noting because the file itself already contains the correct primitive and the project's own Csrf.ts heritage treats challenge-shaped secrets as constant-time material.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:104`

```
return popped.value.value === challenge;
```

## Recommended fix

Route the consume comparison through the file's existing constantTimeEqual for uniformity with the cookie layer; no urgency.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-008` — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual](low/BPAS-008-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, low)_`
- [`CB-007` — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer](low/CB-007-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`TC-003` — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned](medium/TC-003-tim-cappalli.md) `_(tim-cappalli, medium)_`
- [`WPS-003` — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge](medium/WPS-003-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, medium)_`
- [`WPS-008` — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time](low/WPS-008-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`
- [`WPS-009` — layerCookie violates ChallengeStoreShape's documented issue-replacement contract](low/WPS-009-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-challenge-store-hardening`. Duplicate of `BPAS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:104`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
