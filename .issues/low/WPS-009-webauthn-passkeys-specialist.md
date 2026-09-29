---
ID: "WPS-009"
Title: "layerCookie violates ChallengeStoreShape's documented issue-replacement contract"
Level: low
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:60"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-009 — layerCookie violates ChallengeStoreShape's documented issue-replacement contract

`LOW` · `correctness` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

The interface contract says issue replaces the scope's prior unconsumed challenge. layerMemory and layerSql honor that (upsert/HashMap.set), but layerCookie stores nothing, so an old unconsumed value remains valid — and consumable — until its TTL lapses alongside the new one. The test suite honestly documents the related replay limitation ("a still-unexpired value MAY be consumed more than once", ChallengeStore.test.ts:231-233) but the replacement-semantics violation itself is untested and undocumented at the type level, so a caller switching backends inherits silently different ceremony behavior.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:60`

```
/** Mints a fresh challenge scoped to `scope`, replacing whatever this scope's own prior (unconsumed) challenge was, if any. */
```

## Recommended fix

Weaken the shape's doc to state which guarantees each backend provides (or split the interface), and add a cross-backend conformance test asserting the replacement property where it holds.

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
- [`WPS-008` — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time](low/WPS-008-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-challenge-store-hardening`. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:60`. Fix: State per-backend guarantees in the type and prove them with a cross-backend conformance suite. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ChallengeStoreShape.guarantees {singleUse, replacesPriorOnIssue} (memory/sql true/true, cookie false/false); Passkey.layer logs a warning at build when singleUse is false; one shared conformance suite in ChallengeStore.test.ts runs against memory, sql and cookie asserting each property iff claimed (plus an explicit guarantees assertion). BEH-EA-132 text and README document the per-backend guarantees. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
