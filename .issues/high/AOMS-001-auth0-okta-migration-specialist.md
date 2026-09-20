---
ID: "AOMS-001"
Title: "Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt"
Level: high
Category: "architecture"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:42"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-001 — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt

`HIGH` · `architecture` · `ports` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

Auth0 database connections export bcrypt ($2b$) hashes through its migration support process; Okta similarly stores non-argon2 formats. Both shipped layers (layerArgon2id, layerScrypt) verify only their own PHC format, so an imported bcrypt hash stored via Accounts.link({credentialHash}) would fail every sign-in with InvalidCredentials forever. The port header explicitly declares a dual-format verifier 'future work this module doesn't attempt to anticipate'. The rest of the coexistence story is already correct — rehashOnLogin defaults true and the sign-in path calls hasher.needsRehash then accounts.updateCredentialHash (packages/password/src/Password.ts:552-556) — but without a bcrypt-capable layer the single most important Auth0-exit artifact (password hashes) has no landing zone, forcing the mass password reset this plugin architecture was designed to avoid.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:42`

```
// Known non-goal: swapping `PasswordHasher` implementations mid-flight
// (e.g. migrating a fleet from scrypt to argon2id) is not designed against
// here — `verify` only understands its own layer's hash format, matching
```

## Recommended fix

Ship PasswordHasher.layerBcrypt (hash-wasm has no bcrypt; pick bcryptjs or @node-rs/bcrypt) or a dual-format layerArgon2idOrBcrypt whose verify() dispatches on the stored hash's PHC prefix and whose needsRehash() returns true for any $2b$ string, then publish a migration recipe: Auth0 export -> users.create + accounts.link({credentialHash}) + verifyEmail -> first login verifies bcrypt, rehashOnLogin upgrades to argon2id.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`ERS-001` — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload](high/ERS-001-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, high)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [PasswordHasher pluggable verify-only legacy algorithms](../../.scratch/resolve-ready-for-human-findings/issues/21-passwordhasher-legacy-verify-algorithms.md) — adds an additive `LegacyPasswordVerifiers` port (`Context.Reference`, `[]` default) that `layerArgon2id`/`layerScrypt` consult before their own format check; a new `@awthaq/migrate-auth0` package ships a bcrypt (`bcryptjs`) legacy verifier plus the Auth0 export/import recipe, and the existing `rehashOnLogin` path upgrades matched users transparently. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/ports/src/PasswordHasher.ts:42-44` carries exactly the quoted "Known non-goal" comment; the header (lines 1-11, 42-48) confirms only `layerArgon2id`/`layerScrypt` ship, each verifying only its own PHC format. Deciding the migration approach (new bcrypt layer vs. dual-format verifier, and which library) is an explicitly-deferred architecture decision, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented exactly the design from [PasswordHasher pluggable verify-only legacy algorithms](../../.scratch/resolve-ready-for-human-findings/issues/21-passwordhasher-legacy-verify-algorithms.md) (this finding's own decision ticket, which clusters `AOMS-001`/`FAMS-001`):

- `packages/ports/src/PasswordHasher.ts`: new `LegacyPasswordVerifierShape` (`id`, `recognizes`, `verify`) and `LegacyPasswordVerifiers` — a `Context.Reference<ReadonlyArray<LegacyPasswordVerifierShape>>` defaulting to `[]` (BEH-EA-017's pattern, matching ticket 20's `LegacySessionBridge`). `layerArgon2id`/`layerScrypt` both now `yield*` it once at layer-build time and dispatch `verify` legacy-first: a recognized foreign hash goes to the matching verifier, otherwise falls through to the layer's own existing format check exactly as before. `needsRehash` needed no change — it already returns `true` for anything it can't parse as its own format, which now correctly includes every legacy-recognized hash too. `hash()` is completely untouched on both layers — argon2id/scrypt remain the only algorithms either layer ever *produces*.
- New package `@awthaq/migrate-auth0` (`packages/migrate-auth0`): `BcryptVerifier.ts` ships a `bcrypt` `LegacyPasswordVerifierShape` (`recognizes: /^\$2[aby]\$\d{2}\$/`, `verify` via `bcryptjs` — zero native dependencies, matching this port's own standing edge-runtime-compatibility preference, since this path only ever runs off the hot path for a shrinking not-yet-rehashed population) and an installable `layer`; `ImportAuth0User.ts` implements the finding's own recommended recipe (`users.create` + `accounts.link({ credentialHash })`, with `subject: user.id` matching `Password.ts signUp`'s own convention, + conditional `users.verifyEmail`) — the exported bcrypt hash is stored byte-for-byte, no reshaping. `README.md` documents the full 4-step migration recipe.
- **Breaking changes**: none — `PasswordHasherShape`'s public type (`hash`/`verify`/`needsRehash`) is unchanged, and `LegacyPasswordVerifiers`' `[]` default means a deployment that never installs `@awthaq/migrate-auth0` sees zero behavior change.
- **Out of scope, per the decision ticket's own scope note**: `FAMS-001` (`@awthaq/migrate-firebase`, Firebase's modified-scrypt construction) is a separate, still-`ready-for-agent` finding — the decision ticket itself recommends shipping bcrypt/Auth0 first since Firebase's construction is a genuinely fiddlier crypto port that benefits from an audited upstream implementation existing first. The shared `LegacyPasswordVerifiers` port this resolution adds is designed to support it without further changes to `PasswordHasher.ts`.

TDD: 7 new tests across `packages/migrate-auth0/test/{BcryptVerifier,ImportAuth0User}.test.ts` — `recognizes`/`verify` unit coverage, plus two full end-to-end integration tests wiring `BcryptVerifier.layer` into a real `PasswordHasher.layerArgon2id` (not a mock) and asserting a legacy bcrypt hash verifies, a wrong password is rejected, `needsRehash` flags it, and the primary argon2id format is completely unaffected. Verified genuinely load-bearing via a real mutation: neutered the legacy-dispatch `find` call in `PasswordHasher.ts` (`recognizes(phc) && false`), rebuilt `packages/ports/lib` via `tsc -b` (required — `@awthaq/ports` is consumed cross-package via its built `lib/` output, not `src/`, at runtime), and confirmed both integration tests failed for exactly the expected reason (`expected false to be true` on the legacy-hash verify); reverted, rebuilt, confirmed all 7 passing again. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (712 passed, 7 skipped, up from 705); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures noted in prior resolutions).
