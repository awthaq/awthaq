---
ID: "CB-007"
Title: "Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer"
Level: low
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:104"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-007 — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer

`LOW` · `security` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

Both `layerMemory` (line 104) and `layerSql` (line 183) compare the presented challenge to the stored value with plain `===`, while `layerCookie` carefully uses a hand-rolled `constantTimeEqual` over the HMAC. Timing attacks against a 256-bit random challenge comparison are impractical (the store entry is consumed atomically before comparison anyway), so this is hygiene rather than exploitability — but the inconsistency suggests the constant-time discipline is copy-pasted rather than systematic.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:104`

```
return popped.value.value === challenge;
```

## Recommended fix

Reuse one constant-time byte comparison for all three layers (the cookie layer's helper can be shared within the module), or document why string equality is acceptable for the store-backed layers.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: WebAuthn ceremonies
- Full dossier: [`christiaan-brand`](../../.reports/christiaan-brand/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-008` — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual](low/BPAS-008-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, low)_`
- [`HSK-010` — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual](info/HSK-010-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-003` — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned](medium/TC-003-tim-cappalli.md) `_(tim-cappalli, medium)_`
- [`WPS-003` — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge](medium/WPS-003-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, medium)_`
- [`WPS-008` — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time](low/WPS-008-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`
- [`WPS-009` — layerCookie violates ChallengeStoreShape's documented issue-replacement contract](low/WPS-009-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `passkey-challenge-store-hardening`. Duplicate of `BPAS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:104`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → resolved.
