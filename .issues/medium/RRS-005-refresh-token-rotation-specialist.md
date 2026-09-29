---
ID: "RRS-005"
Title: "Zero grace window on rotation: any missed delivery permanently kills the legitimate client"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:161"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-005 — Zero grace window on rotation: any missed delivery permanently kills the legitimate client

`MEDIUM` · `security` · `core` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **resolved**

## Summary

Rotation on the throttled touch overwrites secretHash and the old secret stops verifying immediately, by design. That resolves the retry-vs-theft race 100% toward false revocation: a bearer client that misses the set-auth-token header (Authentication.ts:223), a cookie response lost after the write committed, or the RSC path (RRS-002) leaves the legitimate client retrying a dead secret forever, with re-authentication as the only recovery. Meanwhile the measure buys no theft protection, because reuse detection does not exist (RRS-003) — the old secret dies and nothing observes whether it reappears. The false-revocation cost is taken without the detection benefit the same design would enable.

## Evidence

Source: `packages/core/src/Sessions.ts:161`

```
   * secret's hash is overwritten in the same atomic write, so it stops
   * verifying immediately — no grace window. A concurrent second `verify`
```

## Recommended fix

Keep the previous secretHash in a graceHash column accepted for a short window (30-60s) after rotation so legitimate in-flight retries survive, and emit an event when the grace hash is used — which is precisely the reuse signal RRS-003 needs.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `session-verify-hardening`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:191`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.

**Resolved (2026-09-29):** Implemented a bounded rotation grace window. `SessionConfig.rotationGrace` (optional, default `DEFAULT_ROTATION_GRACE` = 30s, `Duration.zero` = immediate invalidation, i.e. the old behaviour) keeps the secret a throttled touch replaces as a previous-secret hash with its own expiry (`previousSecretHash`/`previousSecretExpiresAt`, core migration 29, written by the same compare-and-swap in `SessionsRepository.touch` and by `Ref.modify` in `layerMemory`). Presenting it inside the window verifies for that session only, re-rotates (the missed-delivery recovery: `rotated` hands back a fresh secret) and publishes `auth.session.rotated` with the new optional `viaGrace` flag; it is never a reuse signal (RRS-003 family revocation and `auth.session.reuse` stay exclusive to a tombstoned row's *current* secret, and a previous secret on a tombstoned row is refused without side effects). Both hashes are always compared so timing does not reveal an open window. Tests (Sessions.test.ts graceSuite, both layers, written before the implementation): lost-delivery recovery, expiry of the window, zero disables, a configured window is honoured, previous secret is per-session, no reuse/family revocation from a grace hit (incl. a since-superseded row), RRS-003 reuse detection still fires with grace configured, viaGrace event; sql contract asserts the touch stores the previous hash. Existing tests that assumed instant invalidation were updated (ticket-01 test, next GetSession). Spec: BEH-EA-052 'Rotation grace window' paragraph. Documented trade-off: two racing rotations can leave a cookie jar on the earlier secret, which then survives only for the window. Gates: clean-build typecheck, full vitest 3085, bdd 1282, test:pg 502, spec:verify:strict, oxlint/oxfmt clean.
