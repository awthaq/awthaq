---
ID: "BAM-004"
Title: "Password digest import requires manual re-serialization; dual-format verify is a declared non-goal"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:44"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-004 — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal

`MEDIUM` · `dx` · `ports` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

The port header states verify understands only its own layer's format and that a dual-format verifier for live algorithm migration is future work. better-auth's stored scrypt digests use a different serialization, so importing them verbatim yields hashes that fail verification (an unparseable digest is treated as needsRehash, but verify still returns false — the user cannot sign in). A no-reset migration is possible: re-serialize each imported digest into the layerScrypt format ($scrypt$ln=,r=,p=$salt$hash) and let the existing BEH-EA-116 rehash-on-login upgrade to the configured floor, but nothing in the repo implements or documents this, and a mistake silently locks users out.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:44`

```
// here — `verify` only understands its own layer's hash format, matching
```

## Recommended fix

Publish a migration recipe (and ideally a tested helper) that maps better-auth scrypt parameters into layerScrypt's passlib-style encoding at import time, paired with the existing updateCredentialHash rehash-on-login; alternatively add a verify-side legacy-format adapter as an explicit port extension.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `legacy-password-migration`. Already fixed by commit 60947ff. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:42`. Fix: Add a better-auth scrypt LegacyPasswordVerifier to @awthaq/migrate-better-auth. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
