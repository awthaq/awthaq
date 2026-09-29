---
ID: "ACS-008"
Title: "Envelope kid and version not bound into the GCM additional authenticated data"
Level: info
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/Encryption.ts:135"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-008 — Envelope kid and version not bound into the GCM additional authenticated data

`INFO` · `security` · `ports` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

The GCM AAD covers only the caller's context string; the envelope's own kid and version fields travel outside authentication. There is no exploit today — a swapped kid fetches the wrong key and fails authentication, and single-key layerEnv means only one kid exists — but once a multi-key KeyProvider ships (the documented rotation plan), an attacker who can rewrite envelopes could force decryption attempts under an attacker-chosen kid, relying purely on key mismatch rather than explicit binding to fail closed.

## Evidence

Source: `packages/ports/src/Encryption.ts:135`

```
              additionalData: new TextEncoder().encode(aad),
```

## Recommended fix

When the multi-key KeyProvider lands, fold kid (and v) into the AAD or the authenticated plaintext header so envelopes are self-authenticating end to end.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `keyprovider-rotation`. Evidence at HEAD ec065a7: `packages/ports/src/Encryption.ts:131`. Fix: Bind envelope version and kid into the GCM AAD (envelope v2), keeping v1 decryptable. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Envelope v2 in packages/ports/src/Encryption.ts: new envelopes carry v:2 and the GCM additionalData is awthaq-enc:v2:<len(kid)>:<kid>:<aad>; v1 still decrypts (legacy AAD) and is always reported staleKid Some so lazy re-encryption upgrades it. Tests in packages/ports/test/Encryption.test.ts: kid rewritten to another known kid (same key bytes) fails DecryptionFailed, v2->v1 downgrade fails, v1 envelope decrypts and reports stale (red first: kid swap decrypted before the change).
