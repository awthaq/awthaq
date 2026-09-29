---
ID: "BPAS-008"
Title: "Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual"
Level: low
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:104"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-008 — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual

`LOW` · `security` · `passkey` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

layerMemory (line 104) and layerSql (line 183) compare the presented challenge with plain string equality, while layerCookie in the same file carefully uses constantTimeEqual for its HMAC (line 298) — an inconsistent hardening discipline one layer apart. Against a 256-bit CSPRNG value the timing channel is not practically exploitable over a network, so this is polish, but the constant-time helper already exists in this module and matching on a secret-bearing value is exactly what it is for.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:104`

```
return popped.value.value === challenge;
```

## Recommended fix

Route the memory/SQL challenge comparison through the module's existing constantTimeEqual (decode base64url to bytes and compare), or drop the helper and document why string equality is acceptable for all three layers.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CB-007` — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer](low/CB-007-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`HSK-010` — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual](info/HSK-010-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-003` — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned](medium/TC-003-tim-cappalli.md) `_(tim-cappalli, medium)_`
- [`WPS-003` — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge](medium/WPS-003-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, medium)_`
- [`WPS-008` — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time](low/WPS-008-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`
- [`WPS-009` — layerCookie violates ChallengeStoreShape's documented issue-replacement contract](low/WPS-009-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-challenge-store-hardening`. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:104`. Fix: Route the memory/SQL final comparison through the module's constantTimeEqual over decoded bytes. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Constant-time challenge comparison: ChallengeStore.ts challengeMatches decodes both values and compares with the shared constantTimeEqual (moved to src/Hmac.ts with hmacSha256/concatBytes, which layerCookie now also imports); no `=== challenge` remains. Regression tests in ChallengeStore.test.ts (non-base64url value; same-length value differing in its first byte) on all layers. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
