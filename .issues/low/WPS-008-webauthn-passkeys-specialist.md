---
ID: "WPS-008"
Title: "Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time"
Level: low
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:104"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-008 — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time

`LOW` · `security` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

layerCookie authenticates the presented value with constantTimeEqual (ChallengeStore.ts:230-235, used at :298), but layerMemory (this line) and layerSql (:183) compare the challenge string with ordinary ===. The exposed value is a 43-character random base64url string compared after an atomic pop, so the timing oracle is impractical in practice — but the inconsistency is real hardening debt in the exact spot the store's own security argument lives, and the plugin already owns the constant-time primitive.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:104`

```
return popped.value.value === challenge;
```

## Recommended fix

Route all three backends' final comparison through the same constantTimeEqual helper.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-008` — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual](low/BPAS-008-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, low)_`
- [`CB-007` — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer](low/CB-007-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`HSK-010` — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual](info/HSK-010-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-003` — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned](medium/TC-003-tim-cappalli.md) `_(tim-cappalli, medium)_`
- [`WPS-003` — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge](medium/WPS-003-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, medium)_`
- [`WPS-009` — layerCookie violates ChallengeStoreShape's documented issue-replacement contract](low/WPS-009-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-challenge-store-hardening`. Duplicate of `BPAS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:104`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
