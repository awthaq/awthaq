---
ID: "PHS-001"
Title: "Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ==="
Level: medium
Category: "security"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:144"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-001 — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===

`MEDIUM` · `security` · `ports` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **ready-for-agent**

## Summary

The module's own comment (lines 63-68) asserts argon2Verify "is expected to compare in constant time internally", and BEH-EA-114 cites "the constant-time hash comparison" as part of the anti-enumeration posture. I verified hash-wasm's source (lib/argon2.ts, argon2Verify): it returns `result.substring(hashStart) === options.hash.substring(hashStart)` - an ordinary JS string equality, which short-circuits on the first differing character. The port already rejects plain === for its own scrypt layer (timingSafeEqualHex exists precisely for this), so the argon2 path applies a weaker standard than the codebase's own stated invariant. Practical exploitability is low (the compared digests are not attacker-steerable without DB read access), but the documented timing-safety guarantee is not actually delivered by the argon2 layer.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:144`

```
Effect.tryPromise(() => argon2Verify({ password: Redacted.value(plain), hash: phc })).pipe(
          Effect.orElseSucceed(() => false),
        );
```

## Recommended fix

Do not delegate comparison: parse the stored PHC's salt/params, recompute with argon2id({ outputType: 'binary' }), and compare digest bytes with the module's existing constant-time helper (generalize timingSafeEqualHex to bytes). Keep argon2Verify only for parsing/validation, or drop it and use the ARGON2ID_PARAMS regex the module already has.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-hasher-verify-hardening`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:175`. Fix: Stop delegating argon2 comparison to hash-wasm: parse, recompute, compare in constant time. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
