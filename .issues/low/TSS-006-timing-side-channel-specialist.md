---
ID: "TSS-006"
Title: "Dummy-hash uniformity degrades under parameter migration: verify runs at the stored hash's cost, not the configured cost"
Level: low
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:144"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-006 — Dummy-hash uniformity degrades under parameter migration: verify runs at the stored hash's cost, not the configured cost

`LOW` · `security` · `ports` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **resolved**

## Summary

signIn's enumeration defense compares verify cost only if both the stored hash and the boot-time dummyHash carry the same KDF parameters. They do not necessarily: argon2Verify derives cost from the stored PHC string, and layerScrypt explicitly re-runs with parsed parameters (PasswordHasher.ts:244 "costFactor: parsed.costFactor"), while dummyHash is produced at boot under current config (Password.ts:447). rehashOnLogin defaults to true (Password.ts:44), which is precisely the flag that guarantees legacy lower-cost rows exist during a parameter upgrade — so during and after such a migration, accounts with legacy hashes verify measurably faster than the unknown-user dummy path, reintroducing a narrower version of the enumeration channel BEH-EA-114 claims (spec/behaviors/15-password.md:46) is removed. The DB-query-count asymmetry (1 lookup unknown vs 3 known) is dominated by the KDF and is not separately material.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:144`

```
Effect.tryPromise(() => argon2Verify({ password: Redacted.value(plain), hash: phc })).pipe(
```

## Recommended fix

Either clamp verify's effective cost (e.g. verify against the stored hash, then additionally run a fixed-cost dummy when needsRehash is true, before deciding failure), or document the residual legacy-parameter timing delta as accepted with a migration-window note next to dummyHash.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: timing side channels
- Full dossier: [`timing-side-channel-specialist`](../../.reports/timing-side-channel-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `password-hasher-verify-hardening`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:276`. Fix: Add a calibrated minimum-duration floor to signIn's credential check and document the residual. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/password/src/Password.ts: PasswordConfig.signInTimingFloor = 'calibrated' (default) | Duration | 'off'. At layer build (after hasher.hash has warmed the KDF) the calibrated mode times one dummy-hash verify and sets the floor to 1.25x; withTimingFloor holds signIn's credential check (lookup + verify, success and failure alike, via Effect.exit + Effect.sleep on Clock so TestClock-safe) and changePassword/reauthenticate's verify to at least the floor. Under TestClock a calibrated floor measures 0 so existing tests are unaffected. Tests (packages/password/test/Password.test.ts, red first: sign-in finished before the floor): explicit 100ms floor with an instant fake hasher holds the fiber until the clock advances; 'off' returns immediately. BEH-EA-114 spec paragraph documents the floor and the residual (costlier-than-floor hashes stay distinguishable until rehashed). Deferred: no real-latency calibration test (wall-clock dependent). Cost: one extra dummy verify per Password layer build. Gates: typecheck (pre-existing react TS2883 only), test 866, bdd 104, spec:verify 19/19. Note: Password.test's APS-003/RBS-001 per-IP throttle tests (30+ argon2 ops, 5s vitest default) occasionally time out when the machine is loaded by parallel typecheck/tests; not caused by these changes (seen before TSS-006 too).
