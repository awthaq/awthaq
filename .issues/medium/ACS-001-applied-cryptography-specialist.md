---
ID: "ACS-001"
Title: "Password KDF executes synchronously on the main event loop"
Level: medium
Category: "performance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:130"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-001 — Password KDF executes synchronously on the main event loop

`MEDIUM` · `performance` · `ports` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

hash-wasm's argon2id and scrypt are synchronous WASM calls wrapped in Effect.promise, so every hash/verify blocks the runtime for the full KDF cost — tens of milliseconds at m=19456 KiB. Because the password plugin deliberately runs a dummy hash even on unknown users (uniform cost, good practice), a login burst serializes the whole server: concurrent sign-ins and unrelated requests queue behind KDF work, turning the expensive-but-correct KDF into an event-loop starvation amplifier.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:130`

```
          return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

## Recommended fix

Run hashing on a worker thread or Effect's blocking/worker facility (or adopt an async native binding like @node-rs/argon2 behind the same port for node deployments); the PasswordHasher port boundary already isolates callers from this change.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `password-hasher-offload`. Duplicate of `ERS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:159`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ERS-001-effect-runtime-scheduler-specialist` — closed by its fix (see that issue's Resolved comment).
