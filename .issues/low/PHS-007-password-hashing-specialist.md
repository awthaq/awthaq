---
ID: "PHS-007"
Title: "Scrypt verify recomputes with stored-hash parameters and no upper bound on cost"
Level: low
Category: "correctness"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:243"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-007 — Scrypt verify recomputes with stored-hash parameters and no upper bound on cost

`LOW` · `correctness` · `ports` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **resolved**

## Summary

parseScryptHash accepts any ln/r/p embedded in a stored string and verify dutifully recomputes at that cost: a corrupted or maliciously rewritten $scrypt$ln=30,... row makes each verification attempt a ~1 GiB-block derivation (128*N*r bytes) before returning false, and an extreme ln makes 2 ** Number(ln) Infinity, throwing into the orElseSucceed(false) path. Exploitation requires database write access or corruption, so this is hardening rather than an exposed vulnerability, but verify is the one place a stored string becomes compute demand, and the argon2 layer has the same shape via argon2Verify parsing attacker-free-but-corruptible params.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:243`

```
salt: parsed.salt,
              costFactor: parsed.costFactor,
              blockSize: parsed.blockSize,
```

## Recommended fix

Clamp parsed parameters to sane ceilings in parseScryptHash (e.g. ln <= 24, r <= 32, p <= 8) and return undefined (verify false, needsRehash true) outside the envelope; apply the analogous envelope check in the argon2 needsRehash/verify parse path.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Password hashing
- Full dossier: [`password-hashing-specialist`](../../.reports/password-hashing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `password-hasher-verify-hardening`. Duplicate of `ACS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:276`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ACS-006-applied-cryptography-specialist` — closed by its fix (see that issue's Resolved comment).
