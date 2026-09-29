---
ID: "ACS-009"
Title: "Env KeyProvider makes key rotation destructive for data at rest"
Level: low
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/KeyProvider.ts:98"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-009 — Env KeyProvider makes key rotation destructive for data at rest

`LOW` · `security` · `ports` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

The only concrete KeyProvider holds exactly one key read from the environment, and getKey fails with UnknownKeyId for any other kid — by design, real rotation is deferred to a future multi-key implementation. Operationally this means an operator who rotates AWTHAQ_ENCRYPTION_KEY permanently orphans every stored provider access/refresh token and PKCE flow payload (all surfacing as OAuthCallbackFailed), with no path to decrypt or migrate them. The kid seam and per-ciphertext kid recording are already correct, so the gap is purely the absence of a production-viable multi-key layer behind the existing interface.

## Evidence

Source: `packages/ports/src/KeyProvider.ts:98`

```
      requestedKid === kid
        ? Effect.succeed(material)
        : Effect.fail(new UnknownKeyId({ kid: requestedKid }));
```

## Recommended fix

Ship a layerEnv variant accepting a JSON map of kid-to-key (current + retired), so ciphertexts written under a previous kid remain decryptable across rotation, and document the migration path.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-007` — Multi-replica secret provisioning is dev-shaped: single env key, no rotation or KMS path shipped](low/AR-007-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`KRS-002` — Only shipped KeyProvider implementation is single-key, making rotation destructive](high/KRS-002-key-rotation-specialist.md) `_(key-rotation-specialist, high)_`
- [`SMS-005` — Key material is never zeroized and raw bytes escape Redacted at the WebCrypto boundary](low/SMS-005-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `keyprovider-rotation`. Duplicate of `KRS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/KeyProvider.ts:96`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
