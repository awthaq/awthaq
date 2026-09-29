---
ID: "WPS-003"
Title: "Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:95"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-003 — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge

`MEDIUM` · `correctness` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **ready-for-agent**

## Summary

consume pops by scope regardless of whether the presented value matches (and layerSql's popByScope at :157 deletes the same way). registerVerify probes the ordinary registration scope first and only then the conditional scope (Passkey.ts:448-461), so when a client completes the Conditional Create autofill ceremony — the normal flow, where both challenges are live for the same session — the probe consumes and discards the session's ordinary challenge before checking it. The user's manual-registration path then fails with PasskeyChallengeInvalid even though its challenge was legitimately issued and unused. The spec's delete-on-every-attempt rule is honored, but the cross-scope destruction is an avoidable self-inflicted failure.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:95`

```
// BEH-EA-132: popped unconditionally in one atomic step — gone whether or not it turns out to match.
```

## Recommended fix

Make consume value-checked atomically (DELETE FROM passkey_challenge WHERE scope = ? AND value = ? RETURNING ...) so a non-matching probe leaves the sibling challenge intact, or route conditional verification by an explicit ceremony discriminator instead of trying both scopes.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-008` — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual](low/BPAS-008-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, low)_`
- [`CB-007` — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer](low/CB-007-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`HSK-010` — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual](info/HSK-010-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-003` — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned](medium/TC-003-tim-cappalli.md) `_(tim-cappalli, medium)_`
- [`WPS-008` — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time](low/WPS-008-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`
- [`WPS-009` — layerCookie violates ChallengeStoreShape's documented issue-replacement contract](low/WPS-009-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-challenge-store-hardening`. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:95`. Fix: Stop probing both registration scopes: the verify payload names its ceremony, and only that scope is consumed. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
