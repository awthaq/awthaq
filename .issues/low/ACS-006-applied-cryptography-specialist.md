---
ID: "ACS-006"
Title: "Embedded KDF parameters honored without a ceiling when verifying scrypt hashes"
Level: low
Category: "security"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:194"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-006 — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes

`LOW` · `security` · `ports` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **ready-for-agent**

## Summary

layerScrypt's verify recomputes the KDF using parameters parsed from the stored hash string with no upper clamp, so a tampered database row carrying ln=30 makes every verification attempt allocate ~128 GiB of WASM memory. The same class applies to argon2id, where hash-wasm's argon2Verify internally honors the hash's embedded m/t/p. Exploitation requires an attacker who can already write credential rows, so it is a hardening gap rather than a live vulnerability, but a memory-hard KDF recomputed from untrusted parameters is a classic DoS pivot and OWASP's guidance is to cap accepted parameters.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:194`

```
    costFactor: 2 ** Number(costLog2Str),
```

## Recommended fix

Clamp parsed parameters to the layer's configured maxima (or reject-and-rehash-needed) before recomputing; document that verify refuses hashes whose cost exceeds the deployment's ceiling.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-hasher-verify-hardening`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:229`. Fix: Clamp stored-hash KDF parameters to configurable ceilings before any recomputation. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
