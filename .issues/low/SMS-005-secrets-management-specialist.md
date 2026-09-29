---
ID: "SMS-005"
Title: "Key material is never zeroized and raw bytes escape Redacted at the WebCrypto boundary"
Level: low
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/KeyProvider.ts:43"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-005 — Key material is never zeroized and raw bytes escape Redacted at the WebCrypto boundary

`LOW` · `security` · `ports` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **resolved**

## Summary

No .fill(0)/zeroization exists anywhere under packages/ - the decoded AES key lives as a plain Uint8Array for the process lifetime, and Encryption unwraps it (Redacted.value(material.key)) on every importKey call (packages/ports/src/Encryption.ts:129,158). Redacted prevents accidental logging but JavaScript runtimes cannot guarantee memory scrubbing, and the codebase nowhere documents this residual exposure. Mitigating factor found during audit: importKey is called with extractable=false and single usage (packages/ports/src/Encryption.ts:116), so the CryptoKey handle itself cannot be re-exported.

## Evidence

Source: `packages/ports/src/KeyProvider.ts:43`

```
readonly key: Redacted.Redacted<Uint8Array>;
```

## Recommended fix

Document the zeroization limitation explicitly in KeyProvider's header; zero the decoded buffer on layer failure paths; for production, point users at the remote/KMS KeyProvider seam so raw key bytes never enter the process at all.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-007` — Multi-replica secret provisioning is dev-shaped: single env key, no rotation or KMS path shipped](low/AR-007-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`ACS-009` — Env KeyProvider makes key rotation destructive for data at rest](low/ACS-009-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`KRS-002` — Only shipped KeyProvider implementation is single-key, making rotation destructive](high/KRS-002-key-rotation-specialist.md) `_(key-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `keyprovider-rotation`. Evidence at HEAD ec065a7: `packages/ports/src/KeyProvider.ts:43`. Fix: Minimise raw key-byte lifetime and document the residual exposure. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Encryption.layer caches one non-extractable CryptoKey per (kid,usage) in a Ref<HashMap> (raw bytes unwrapped once per kid) and zeroes the transient copy passed to importKey; layerEnv zeroes the decoded buffer on the wrong-length die path; KeyProvider.ts header + README document that JS cannot guarantee zeroization and Redacted only prevents logging, recommending a KMS-backed KeyProvider. Test: Encryption.test.ts 'imports each (kid, usage) once across 10 encrypt+decrypt round trips' (spy on subtle.importKey; was 20 imports before).
