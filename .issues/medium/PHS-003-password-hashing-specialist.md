---
ID: "PHS-003"
Title: "CPU-bound WASM hashing runs on the main thread with no concurrency bound"
Level: medium
Category: "performance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:130"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-003 — CPU-bound WASM hashing runs on the main thread with no concurrency bound

`MEDIUM` · `performance` · `ports` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **resolved**

## Summary

hash-wasm loads its module asynchronously but executes the argon2 computation as a synchronous WASM export call (argon2Internal -> calculate), so Effect.promise here blocks the entire JS thread - the event loop and every Effect fiber on it - for the full derivation (order tens of ms at m=19456, t=2; OWASP's own guidance notes excessive work factor is a DoS vector via CPU exhaustion). Nothing bounds concurrency: no semaphore, no worker pool anywhere in either package (grep for Semaphore/Worker/concurrency finds only comments), and each in-flight call allocates ~19.9 MB of WASM memory (hash-wasm setMemorySize(memorySize * 1024 + 1024)). RATE_LIMITS.signIn is 5/15min per email (Password.ts:157), which bounds per-account work but not global concurrency - N distinct emails yield N parallel 19 MiB blocking derivations. This is exactly the fiber-starvation risk the persona and spec call out for CPU-bound work in an Effect runtime.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:130`

```
return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

## Recommended fix

Wrap hash/verify in a bounded Effect semaphore sized to cores (e.g. 2-4) to cap concurrent derivations and memory, and/or offload to a worker pool (@effect/platform Worker/WorkerRunner or node:worker_threads) so the runtime's scheduler stays responsive during derivations. Add a documented concurrency knob alongside the existing env vars.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `password-hasher-offload`. Duplicate of `ERS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:159`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
