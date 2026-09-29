---
ID: "ERS-001"
Title: "argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload"
Level: high
Category: "performance"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/PasswordHasher.ts:130"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-001 — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload

`HIGH` · `performance` · `ports` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **ready-for-agent**

## Summary

Both layerArgon2id (line 130) and layerScrypt (lines 222, 240) execute hash-wasm through Effect.promise. The WASM computation runs synchronously on the calling thread — Effect's cooperative fiber scheduler cannot preempt it — so with the configured defaults (19456 KiB argon2id, 2^17 = 131072 KiB scrypt) every sign-in/sign-up/rehash stalls ALL request fibers for tens to hundreds of milliseconds and allocates up to 128 MiB per call. N concurrent authentications serialize behind each other on the single event loop; no worker pool, NodeWorker layer, or bounded semaphore exists anywhere in the repo. This is exactly the 'hashing vs pool' hazard: an unauthenticated endpoint whose cost scales with attacker-triggerable traffic.

## Evidence

Source: `packages/ports/src/PasswordHasher.ts:130`

```
return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

## Recommended fix

Offload hashing to a worker pool (piscina, or an Effect NodeWorker-based Layer) so the event loop stays responsive, or switch to a native async implementation that uses the libuv threadpool. Additionally bound concurrent hash operations with an Effect.semaphore (e.g. 2-4 permits) so memory-bounded work cannot pile up, and document the expected per-hash latency next to the AUTH_ARGON2_* config knobs.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-001` — Password KDF executes synchronously on the main event loop](medium/ACS-001-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- [`ACS-006` — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes](low/ACS-006-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`AOMS-001` — Auth0 bcrypt password hashes cannot be verified: shipped hashers accept only argon2id/scrypt](high/AOMS-001-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BAM-004` — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal](medium/BAM-004-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, medium)_`
- [`ERAS-004` — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets](low/ERAS-004-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`ECF-004` — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler](medium/ECF-004-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, medium)_`
- [`FAMS-001` — No Firebase scrypt-variant password verification path; lazy rehash is impossible](high/FAMS-001-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, high)_`
- [`PHS-001` — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===](medium/PHS-001-password-hashing-specialist.md) `_(password-hashing-specialist, medium)_`
- … 6 more findings touch `packages/ports/src/PasswordHasher.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/ports/src/PasswordHasher.ts:130` exactly; `layerScrypt`'s `hash`/`verify` (lines 222, 240) use the identical `Effect.promise`-wrapped hash-wasm pattern, and `grep -rn "NodeWorker\|piscina\|Worker(\|Semaphore"` over `packages/*/src` finds nothing — no worker pool or concurrency bound exists anywhere. hash-wasm runs its WASM computation synchronously on the calling thread, so the claim holds. Choosing a worker-thread strategy is an architecture decision with cross-cutting effects (e.g. edge-runtime portability, per ERAS-002/ECF-004), not a narrow mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [PasswordHasher worker-pool offload (main-thread blocking)](../../.scratch/resolve-ready-for-human-findings/issues/35-passwordhasher-worker-offload.md) — always-on `Effect.Semaphore` concurrency bound on the existing main-thread `layerArgon2id`/`layerScrypt` (edge-safe, no new dependency), plus new opt-in Node-only `layerArgon2idNodeWorkerPool`/`layerScryptNodeWorkerPool` layers built on `effect/Pool` + `effect/unstable/workers/Worker`/`@effect/platform-node`'s `NodeWorker`, same `PasswordHasherShape`, app-provided per ADR-EA-010. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `password-hasher-offload`. Evidence at HEAD ec065a7: `packages/ports/src/PasswordHasher.ts:159`. Fix: Bound hashing concurrency on the WASM layers and add opt-in Node worker-pool PasswordHasher layers (decision 35). (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
