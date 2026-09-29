---
ID: "WPS-010"
Title: "Credential create has no duplicate-id guard and the two layers diverge on collision"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/PasskeyCredentials.ts:105"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-010 — Credential create has no duplicate-id guard and the two layers diverge on collision

`LOW` · `correctness` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **ready-for-agent**

## Summary

create blindly writes by credential id. layerMemory's HashMap.set silently overwrites an existing row — re-registering the same authenticator against a different account would move the credential to the new owner while the old account's Accounts link still points at it; layerSql's plain INSERT would instead throw a PK violation swallowed by Effect.orDie into a defect (PasskeyCredentials.ts:299-314). excludeCredentials only lists the current user's own credentials, so nothing at the ceremony level prevents cross-account id reuse by a misbehaving authenticator.

## Evidence

Source: `packages/passkey/src/PasskeyCredentials.ts:105`

```
yield* Ref.update(state, (s) => HashMap.set(s, record.id, record));
```

## Recommended fix

Check findById before create and fail with a typed error (or make both layers explicitly upsert), keeping memory and SQL behavior identical.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-wire-contract`. Evidence at HEAD ec065a7: `packages/passkey/src/PasskeyCredentials.ts:104`. Fix: Make create collision-aware and identical across layers with a typed error. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
