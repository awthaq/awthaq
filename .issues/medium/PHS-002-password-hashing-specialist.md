---
ID: "PHS-002"
Title: "needsRehash uses strict equality, enabling silent downgrade of stronger hashes"
Level: medium
Category: "security"
Status: ready-for-human
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:152"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-002 — needsRehash uses strict equality, enabling silent downgrade of stronger hashes

`MEDIUM` · `security` · `ports` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **ready-for-human**

## Summary

The header comment (lines 31-40) states the rehash triggers are "(a) a legacy algorithm, (b) parameters below the current configured floor" per OWASP's Upgrading the Work Factor guidance, but the implementation flags ANY hash whose parameters merely differ from the current config - including hashes with strictly STRONGER parameters. Concretely: an operator who temporarily lowers AUTH_ARGON2_MEMORY_KIB or AUTH_ARGON2_ITERATIONS (load experiment, misconfig, tenant-specific tuning) causes every user who signs in during that window to have their stronger hash re-written with weaker parameters via Password.ts:552-557, silently and permanently. Equality-based triggers also make 'raise parameters fleet-wide then restore' semantics fragile: the safe direction of migration (upgrade) is conflated with the unsafe one (downgrade).

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:152`

```
return (
          params.memorySize !== memorySize ||
          params.iterations !== iterations ||
```

## Recommended fix

Implement floor semantics: needsRehash returns true only when the stored hash's cost is strictly weaker than configured (e.g. m < memorySize, or (m,t) ordered by an equivalent-strength comparison against the OWASP-equivalent-config table), never when stronger. Add a regression test: hash under strong params, lower config, assert needsRehash is false and signIn leaves the stored hash untouched.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-hasher-verify-hardening`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:183`. Fix: (Recommended option C) Add a rehash policy knob defaulting to floor semantics, amend BEH-EA-116, fix the header comment. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-human.
