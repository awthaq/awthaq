---
ID: "ECF-004"
Title: "argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler"
Level: medium
Category: "performance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:130"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-004 — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler

`MEDIUM` · `performance` · `ports` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

hash-wasm executes its computation synchronously on the JS thread; wrapping it in Effect.promise makes the fiber suspendable around the promise but cannot preempt the ~19 MiB / t=2 argon2id work itself (m=19456,t=2,p=1 defaults, PasswordHasher.ts:122-125). Every hash/verify — including the deliberate dummyHash verify on each sign-in (Password.ts:447,529) — monopolizes the single thread for its full duration, so under concurrent logins all other fibers (including unrelated requests) queue behind the event loop. No Semaphore gates admission and no worker offload exists, so hashing throughput equals exactly one core and tail latency grows linearly with concurrency.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:130`

```
return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

## Recommended fix

Either offload to a worker pool (hash-wasm itself advertises Web Worker support; on Node a small worker_threads pool or @node-rs/argon2's native async binding) or at minimum bound concurrent hash/verify with a semaphore so saturation degrades gracefully instead of silently stalling everything. Document the chosen concurrency ceiling next to the OWASP defaults.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `password-hasher-offload`. Duplicate of `ERS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:159`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
