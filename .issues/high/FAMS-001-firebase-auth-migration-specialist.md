---
ID: "FAMS-001"
Title: "No Firebase scrypt-variant password verification path; lazy rehash is impossible"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:44"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-001 — No Firebase scrypt-variant password verification path; lazy rehash is impossible

`HIGH` · `architecture` · `ports` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

Firebase exports password hashes as a modified scrypt computed with a per-project signer key and salt separator (base64_signer_key, base64_salt_separator, rounds, mem_cost). effect-auth's layerScrypt uses hash-wasm's plain scrypt with a random per-hash salt (packages/ports/src/PasswordHasher.ts:57, 209) and no parameter slot for an external signer key, and the port comment explicitly scopes dual-format/live-migration verification out as future work. Consequence: imported Firebase hash strings cannot be verified at all — layerScrypt's parse fails and verify returns false — so the persona's lazy-rehash plan (verify legacy once at next login, then re-hash) has no implementation path. Ironically the rehash hook itself already exists and is correct: Password.ts:552 checks config.rehashOnLogin && hasher.needsRehash(...), and needsRehash deliberately returns true for any hash the layer cannot parse (packages/ports/src/PasswordHasher.ts:148-156). What is missing is solely a verifier that can check the legacy Firebase format.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:44`

```
// Known non-goal: swapping `PasswordHasher` implementations mid-flight
// (e.g. migrating a fleet from scrypt to argon2id) is not designed against
// here — `verify` only understands its own layer's hash format, matching
```

## Recommended fix

Add a Firebase-compatible PasswordHasher layer (or a composite dual-format layer) that accepts hash_config parameters (signer key, salt separator, rounds, mem_cost) via config, computes Firebase's scrypt variant over the signer key with saltSeparator+salt, and delegates successful verification to the native hasher for the rehash write. The existing rehashOnLogin flow then completes the lazy migration with no forced password resets.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [PasswordHasher pluggable verify-only legacy algorithms](../../.scratch/resolve-ready-for-human-findings/issues/21-passwordhasher-legacy-verify-algorithms.md) — same `LegacyPasswordVerifiers` port as `AOMS-001`; a new `@awthaq/migrate-firebase` package ships a `firebase-scrypt` legacy verifier (params embedded in a de-facto `$firebase-scrypt$...$` hash tag, using an audited implementation of Firebase's modified-scrypt construction rather than a home-rolled one) plus the Firebase export/import and linked-provider recipe, restoring the lazy-rehash path the port comment had scoped out. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/ports/src/PasswordHasher.ts:37-43` documents dual-format/migration verification as an explicit non-goal, `layerScrypt` (lines ~160-208) uses `hash-wasm`'s plain scrypt with no signer-key/salt-separator parameter slot, and the rehash hook is confirmed real and correct (`Password.ts:552` gates on `config.rehashOnLogin && hasher.needsRehash(...)`, and `needsRehash` at `PasswordHasher.ts:148-156` returns `true` for any unparseable hash). Building Firebase-format support is a genuine new-capability/product decision (whether to invest in Firebase migration parity at all, and how to shape the config surface), not a bug fix. Status → ready-for-human.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `legacy-password-migration`. Already fixed by commit 60947ff. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:42`. Fix: Ship @awthaq/migrate-firebase with a firebase-scrypt LegacyPasswordVerifier (decision 21). (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
