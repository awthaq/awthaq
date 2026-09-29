---
ID: "KRS-002"
Title: "Only shipped KeyProvider implementation is single-key, making rotation destructive"
Level: high
Category: "architecture"
Status: resolved
Package: "ports"
Source: "packages/ports/src/KeyProvider.ts:98"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-002 — Only shipped KeyProvider implementation is single-key, making rotation destructive

`HIGH` · `architecture` · `ports` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

The port is correctly shaped for rotation (currentKey for new ciphertexts, getKey by a ciphertext's own kid) and its header admits real multi-key support is 'a property of a future multi-key implementation'. But the only implementation that exists knows exactly one key: getKey fails UnknownKeyId for every other kid. An operator who rotates AWTHAQ_ENCRYPTION_KEY_ID/AWTHAQ_ENCRYPTION_KEY instantly orphans every existing envelope — stored OAuth access/refresh tokens and in-flight PKCE/nonce state written under the old kid become permanently undecryptable, and there is no re-encryption or migration tool anywhere in the repo.

## Evidence

Source: `packages/ports/src/KeyProvider.ts:98`

```
const getKey: KeyProviderShape["getKey"] = (requestedKid) =>
  requestedKid === kid
    ? Effect.succeed(material)
```

## Recommended fix

Ship a multi-key KeyProvider (e.g. env-var or KMS map of kid -> material, with currentKey naming the newest) and a lazy or batched re-encryption path for old-kid rows; until one exists, document that changing the encryption key requires a data migration the runtime does not provide.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-007` — Multi-replica secret provisioning is dev-shaped: single env key, no rotation or KMS path shipped](low/AR-007-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`ACS-009` — Env KeyProvider makes key rotation destructive for data at rest](low/ACS-009-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`SMS-005` — Key material is never zeroized and raw bytes escape Redacted at the WebCrypto boundary](low/SMS-005-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [KeyProvider multi-key rotation support](../../.scratch/resolve-ready-for-human-findings/issues/22-keyprovider-multi-key-rotation.md) — replace `layerEnv` with a real multi-key implementation (`AWTHAQ_ENCRYPTION_KEYS` JSON keyset + `AWTHAQ_ENCRYPTION_KEY_ID` naming the current kid, `getKey` a real lookup over retired keys) plus a `staleKid` signal on `Encryption.decrypt` enabling lazy re-encryption on next read. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/ports/src/KeyProvider.ts:97-100` matches the evidence verbatim; `layerEnv`'s `getKey` fails `UnknownKeyId` for any kid but the one loaded at construction, and the module's own header comment (lines 20-24) concedes "real rotation support ... is a property of a future multi-key implementation of this interface." No multi-key `KeyProvider` implementation or re-encryption/migration tool exists anywhere in the repo. Shipping a multi-key provider plus a re-encryption path is a real design decision (KMS shape, migration strategy), not a small mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `keyprovider-rotation`. Evidence at HEAD ec065a7: `packages/ports/src/KeyProvider.ts:96`. Fix: Multi-key layerEnv + staleKid-driven lazy re-encryption, exactly as decision 22 specifies. (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.

**Resolved (2026-09-29):** packages/ports/src/KeyProvider.ts: layerEnv now reads the AWTHAQ_ENCRYPTION_KEYS keyset (JSON [{kid,key}], Schema-decoded, base64 32-byte keys, empty/duplicate kid/bad length die, current kid AWTHAQ_ENCRYPTION_KEY_ID required and must be in the set); getKey is a lookup over the whole set. packages/ports/src/Encryption.ts: decrypt now returns {plaintext, staleKid: Option<string>}. Consumers: sql AccountsRepository lazy re-encrypts stale reads via CAS (see SMS-002); oauth PKCE/nonce read .plaintext. README (env vars, one-entry migration, retirement procedure) and ADR-EA-019 (spec/decisions/019-encryption-key-rotation.md, indexed + traceability). Tests: packages/ports/test/KeyProvider.test.ts + Encryption.test.ts (red first: keyset tests failed as AWTHAQ_ENCRYPTION_KEYS was ignored). Gates: typecheck, full vitest, bdd, spec:verify:strict, oxlint clean for touched files. Decision (2026-09-29): deviated from ticket 22 in ONE respect: the legacy single-key AWTHAQ_ENCRYPTION_KEY (kid defaults to env) is still accepted when AWTHAQ_ENCRYPTION_KEYS is unset, as a one-entry non-rotating keyset, so the many existing test fixtures in other packages keep working; a keyset always requires KEY_ID. User may revisit.
