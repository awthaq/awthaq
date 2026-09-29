---
ID: "TTE-005"
Title: "PHC password hashes are unbranded strings — branding stops at entity IDs"
Level: low
Category: "api"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:80"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-005 — PHC password hashes are unbranded strings — branding stops at entity IDs

`LOW` · `api` · `ports` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

The raw-vs-hashed distinction is half-built: plaintext inputs are correctly forced through `Redacted.Redacted<string>` (a bare string will not type-check), but the hash output is a plain `string` and `verify`/`needsRehash` accept any string — a session secret hex, a username, or an arbitrary literal type-checks as a PHC hash. Runtime paths fail closed (argon2Verify returns false, scrypt parse returns undefined), which is why this is low, but the type system is doing none of the work the repo applies to `SessionId`/`UserId`, and `Sessions`/`Accounts` store `secretHash: string` with the same looseness.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:80`

```
readonly hash: (plain: Redacted.Redacted<string>) => Effect.Effect<string>;
readonly verify: (plain: Redacted.Redacted<string>, phc: string) => Effect.Effect<boolean>;
```

## Recommended fix

Introduce `export type PhcHash = string & Brand.Brand<"PhcHash">` in ports, return it from `hash`, accept it in `verify`/`needsRehash`, and thread it through `PasswordHasherShape`, `AccountsShape.credentialHashes`, and `SessionRow.secretHash`; the scrypt/argon2 parsers become the only places that mint the brand, from validated parses.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `phc-hash-branding`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:82`. Fix: Introduce a PhcHash brand and thread it through the hasher port and credential storage. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** PasswordHasher.PhcHash brand (Brand.nominal) threaded through the port: hash returns it, verify/needsRehash/LegacyPasswordVerifier take it; Accounts stores/returns Redacted<PhcHash> and mints at the repository read boundary; migrate-auth0 and migrate-firebase mint at import. Type test with @ts-expect-error in ports PasswordHasher.test.ts; existing tests mint explicitly. No 'as' introduced.
