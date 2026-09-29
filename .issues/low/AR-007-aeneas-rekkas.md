---
ID: "AR-007"
Title: "Multi-replica secret provisioning is dev-shaped: single env key, no rotation or KMS path shipped"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/KeyProvider.ts:63"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-007 — Multi-replica secret provisioning is dev-shaped: single env key, no rotation or KMS path shipped

`LOW` · `dx` · `ports` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **ready-for-agent**

## Summary

Every replica must share AWTHAQ_ENCRYPTION_KEY (AES-256, base64) and the CsrfConfig HMAC secret for cookies minted by one node to verify on another; the KeyProvider header calls its env implementation a 'Dev/test seam' and the README's own table answers 'a KMS-backed KeyProvider (implement the port directly)' (README.md:217). The seam is genuinely KMS-shaped (kid-based KeyMaterial), so this is honest scaffolding rather than a defect — but for a platform product there is no shipped story for key rotation, dual-key decrypt windows, or per-deployment secret distribution, and CSRF/session secrets live in ad-hoc config references rather than the same provisioning path.

## Evidence

Source: `packages/ports/src/KeyProvider.ts:63`

```
* Dev/test seam: one key, read once from the environment at layer
```

## Recommended fix

Document a multi-replica deployment contract (shared secret checklist: AWTHAQ_ENCRYPTION_KEY, CSRF secret) and add a KeyProvider wrapper that supports kid-keyed rotation (verify under current, decrypt under current-or-previous) — the kid field already exists to carry it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-009` — Env KeyProvider makes key rotation destructive for data at rest](low/ACS-009-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`KRS-002` — Only shipped KeyProvider implementation is single-key, making rotation destructive](high/KRS-002-key-rotation-specialist.md) `_(key-rotation-specialist, high)_`
- [`SMS-005` — Key material is never zeroized and raw bytes escape Redacted at the WebCrypto boundary](low/SMS-005-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `keyprovider-rotation`. Evidence at HEAD ec065a7: `packages/ports/src/KeyProvider.ts:62`. Fix: Document a multi-replica deployment contract once KRS-002 (keyset) and RBS-004 (shared rate-limit store) exist. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
