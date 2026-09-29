---
ID: "SAM-001"
Title: "No bcrypt verification: migrated GoTrue password users are uniformly InvalidCredentials"
Level: high
Category: "api"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:42"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-001 — No bcrypt verification: migrated GoTrue password users are uniformly InvalidCredentials

`HIGH` · `api` · `ports` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

GoTrue stores password hashes as bcrypt ($2a$/$2y$). The shipped hasher layers import only argon2id and scrypt from hash-wasm (packages/ports/src/PasswordHasher.ts:57), and the port contract pins verify to one layer's own format, with a dual-format verifier explicitly named as unanticipated future work. Under layerArgon2id, argon2Verify fails on a bcrypt string and verify resolves false, so packages/password's signIn (packages/password/src/Password.ts:529-540) fails every migrated user with the uniform InvalidCredentials error. This is the single hard blocker for the user-table half of a Supabase migration.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:42`

```
// Known non-goal: swapping `PasswordHasher` implementations mid-flight
// (e.g. migrating a fleet from scrypt to argon2id) is not designed against
// here — `verify` only understands its own layer's hash format,
```

## Recommended fix

Ship a first-class BcryptHasher.layer (or a documented dual-format verifier layer for the cutover window) that verifies $2a$/$2b$/$2y$ strings and hashes new passwords with argon2id; its needsRehash already returns true for unparseable formats, so rehashOnLogin (default true) upgrades each user to argon2id on first successful sign-in with zero further code.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — PasswordHasher.ts:42-44's non-goal comment matches verbatim, only argon2id/scrypt layers exist (`hash-wasm` import), and Password.ts's `signIn` calls `hasher.verify` which fails on non-native hash formats, yielding `InvalidCredentials`. `rehashOnLogin` defaults `true` and `needsRehash` exists, so the recommended `BcryptHasher.layer` addition is a clean, well-scoped fix. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `legacy-password-migration`. Already fixed by commit 60947ff. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:42`. Fix: Document and pin the Supabase/GoTrue bcrypt path on top of the existing verifier. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
