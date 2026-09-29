---
ID: "ACS-006"
Title: "Embedded KDF parameters honored without a ceiling when verifying scrypt hashes"
Level: low
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:194"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-006 — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes

`LOW` · `security` · `ports` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

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

**Resolved (2026-09-29):** Ceilings on stored-hash KDF params, both layers, no KDF run on violation: AUTH_ARGON2_MAX_MEMORY_KIB=262144, _MAX_ITERATIONS=16, _MAX_PARALLELISM=8, AUTH_SCRYPT_MAX_COST_LOG2=20, _MAX_BLOCK_SIZE=32, _MAX_PARALLELISM=16 (Config.Int with defaults); each must be >= the layer's own target or the layer build dies (Effect.die). Parsers require integer params in [1, ceiling] (ln checked before 2**ln); addition beyond the dossier: scrypt N*r is bounded by 2^maxCostLog2 * max(target r, 8) so independent per-axis ceilings cannot combine into a multi-GiB allocation (defaults alone would allow 4 GiB). verify returns false and needsRehash true for violating hashes. verify now uses Effect.tryPromise (a hash-wasm throw is false, not a defect) in both layers. Tests (2s timeout): argon2 m=4194304 and scrypt ln=25 -> false without KDF (scrypt one red: old code threw RangeError), layer build dies below-target ceilings. Gates as PHS-001.
