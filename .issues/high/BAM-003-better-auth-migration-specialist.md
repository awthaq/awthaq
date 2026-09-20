---
ID: "BAM-003"
Title: "Session cutover invalidates every live better-auth session with no bridge"
Level: high
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:258"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-003 — Session cutover invalidates every live better-auth session with no bridge

`HIGH` · `api` · `core` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

effect-auth sessions are `id.secret` pairs under the __Host-session cookie (Sessions.ts:123), looked up by id with constant-time comparison of SHA-256(secret); a token without a '.' separator fails as malformed (Sessions.ts:264-267). better-auth sessions are single opaque tokens in a differently-named cookie, so no better-auth credential can ever verify against migrated rows — the verify path structurally cannot accept them. There is no dual-read window, no cookie re-issue endpoint, and no documented cutover plan; the default outcome is a forced mass re-login, exactly the red flag this role's rubric screens for.

## Evidence

Source: `packages/core/src/Sessions.ts:258`

```
return { session: toView(row), token: Redacted.make(`${id}.${secret}`) };
```

## Recommended fix

Document and implement a cutover choice: either (a) a migration that pre-computes secretHash values plus a one-time, signed cookie-reissue endpoint that exchanges a still-live better-auth token for a freshly issued awthaq session, or (b) an explicit, versioned decision that cutover means forced re-login, so integrators can plan around it.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [better-auth session cutover migration bridge](../../.scratch/resolve-ready-for-human-findings/issues/20-better-auth-session-cutover-bridge.md) — ships an optional `LegacySessionBridge` port (no-op by default) that `Sessions.verify` consults on a parse/lookup miss, bridging a still-live better-auth session into a freshly-minted awthaq session via the already-shipped `rotated` delivery channel; an un-migrated deployment sees no change (forced re-login remains the default when the bridge isn't installed). Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/Sessions.ts:258` matches exactly (`token: Redacted.make(\`${id}.${secret}\`)`), and `verify` (line ~264) rejects any token without a `.` separator as malformed, so a better-auth opaque token structurally cannot verify. No dual-read or reissue-bridge code exists. Choosing the cutover strategy (dual-read bridge vs. accepted forced re-login) is a product/architecture decision the report itself frames as an either/or choice. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented [better-auth session cutover migration bridge](../../.scratch/resolve-ready-for-human-findings/issues/20-better-auth-session-cutover-bridge.md) exactly as decided — the false-dichotomy resolution: (a) is now the installable adapter, (b) — forced re-login — remains the literal default for any deployment that doesn't install it.

- New `packages/ports/src/LegacySessionBridge.ts`: a `Context.Reference` (no-op default), mirroring `Authentication.ts`'s own `PostAuthResponseHook` pattern, `userId` a bare `string` (Ports sits below Domain, cannot depend on Core's branded `UserId`).
- `packages/core/src/Sessions.ts`: `verify` (both `layerMemory`/`layerSql`) consults the bridge at its two primary-store-miss points — the dot-less malformed branch and the id-not-found branch — via a `bridgeLegacySession` helper that mints through the layer's own `issue`, then calls `bridge.consume`, modeling a hit as "rotated from nothing valid to a fresh session" through the already-shipped `rotated` channel (ticket 01) — **no change to `SessionsShape["verify"]`'s return type**, so no downstream call site needed updating. Caught a real bug while writing the first test for this: `bridge` must be resolved *once*, at layer-build time (the same pattern already established for `crypto`/`config`/`events` in this same function), not per-`verify`-call inside the closure — resolving it call-time silently fell back to the reference's default no-op regardless of what was actually provided, since a closure invoked later runs in its *caller's* ambient context, not the context the layer was built under.
- New package `@awthaq/migrate-better-auth`: `LegacySessionBridgeLive` (`SqlClient`-backed, queries a retained better-auth `session` table by its own literal `token` column, checks `expiresAt`, `consume` deletes the row) and `AliasLegacyCookieMiddleware` (a generic `HttpMiddleware`, built on `Effect.updateService`/`HttpServerRequest.modify`, rewriting the ambient request's cookie header so a present legacy cookie aliases into `__Host-session` only when the primary cookie is absent — keeps `Sessions`/`Api`'s public types untouched, per `ADR-EA-003`'s contract/HTTP separation, the same design the decision ticket itself specified). README covers the full install + rollout sequence.

TDD: `packages/core/test/LegacySessionBridge.test.ts` (dual-layer, proves a still-live legacy token bridges into a real session and becomes single-use) caught the build-time-vs-call-time bug above for real, before any mutation testing began — a genuine TDD save, not a formality. `packages/migrate-better-auth/test/LegacySessionBridgeLive.test.ts` (expiry check, unrecognized token, single-use consume) and `AliasLegacyCookieMiddleware.test.ts` (aliases only when absent, leaves the cookie header byte-for-byte untouched otherwise — strengthened from an initial version that checked only the derived `cookies` dict, which didn't actually detect a missing early-return guard because this parser's first-key-wins semantics happened to mask it; the byte-for-byte header comparison does catch it). Every new assertion mutation-verified (disabled the expiry check, removed the middleware's early-return guard, reverted `Sessions.ts`'s bridge-consulting branches entirely) — each confirmed to fail for exactly the expected reason, then reverted. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (732 passed, up from 721); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures).

**Out of scope**: this package's own schema assumption (better-auth's `session` table shape) is stated, not verified against a real better-auth deployment or its source — flagged plainly in the README, the same posture `@awthaq/migrate-auth0`'s own bcrypt-format assumption took for AOMS-001.
