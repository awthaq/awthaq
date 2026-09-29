---
ID: "ERAS-004"
Title: "WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets"
Level: low
Category: "performance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:24"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-004 — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets

`LOW` · `performance` · `ports` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **resolved**

## Summary

The in-code claim cross-checks: hash-wasm is a pure-WASM, zero-native dependency (packages/ports/src/PasswordHasher.ts:57) so hash/verify do run in isolate runtimes with WebAssembly support. But feasibility is not advisability: the OWASP default m=19456 KiB, t=2 (PasswordHasher.ts:121-123) costs tens of milliseconds of CPU per verify, well over Cloudflare Workers' free-tier 10 ms CPU limit and a meaningful paid-plan cost on every sign-in. Nothing in the docs draws this line, and an edge deployment that naively routes password verify through the edge tier will discover it in production.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:24`

```
// own words: "hash-wasm v4.12.0 (MIT, zero-dep pure WASM, runs in
// browsers/Node/Deno/Web Workers) brings argon2id to edge runtimes" — the
```

## Recommended fix

Document explicitly: password hash/verify belongs on the origin/long-running runtime; the edge tier's job is token verification and redirects. Optionally expose a cheaper edge-only hasher profile for sign-in rate checks, but never for storage hashes.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-hasher-offload`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:24`. Fix: Document where password hashing should run. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Documented in the PasswordHasher.ts header, README 'Password hashing' section and BEH-EA-115: hashing belongs on the origin runtime, default cost vs Workers CPU budgets, no cheaper edge profile.
