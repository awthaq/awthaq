---
ID: "AAPS-001"
Title: "reauth obligation measures session-mint age with no authenticatedAt and no discharge path"
Level: high
Category: "correctness"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:141"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-001 — reauth obligation measures session-mint age with no authenticatedAt and no discharge path

`HIGH` · `correctness` · `qadi` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

BEH-EA-165 requires the handler to compare the session's `authenticatedAt` to maxAgeSeconds, and spec/appendices/02-qadi-path-a-end-to-end.md:270-272 promises `client.session.reauthenticate` that "refreshes `authenticatedAt` without issuing an entirely new session". Neither exists: SessionView (packages/core/src/Sessions.ts:90-101) has only createdAt, SessionsShape (lines 131-200) has no method that refreshes an authentication timestamp, and packages/client has no reauthenticate (grep: zero matches). The handler substitutes createdAt, which rotation deliberately preserves (Sessions.ts:327-328 spreads the existing row), so `reauth(300)` is un-dischargeable: once the session is older than the window, the ReauthRequired error maps to a "confirm your password" prompt (Resolvers.ts:92) for which no endpoint exists — the user's only escape is a full sign-out and sign-in. Conversely, session creation is treated as authentication even when the mint was not a credential presentation.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:141`

```
const now = yield* DateTime.now;
const age = DateTime.distance(current.createdAt, now);
if (Duration.isGreaterThan(age, Duration.seconds(maxAgeSeconds))) {
```

## Recommended fix

Add `authenticatedAt` to SessionRow/SessionView (set at issue, updated by a new Sessions method such as `reauthenticate`), have reauthHandler read that field instead of createdAt, and either ship the password-confirmation endpoint that refreshes it or cut the reauthenticate promise from the spec until the flow exists end to end.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/qadi/src/Resolvers.ts:140-141` compares `current.createdAt` (not an `authenticatedAt`), and `SessionView`/`SessionRow` (`packages/core/src/Sessions.ts:90-101`) carry no `authenticatedAt` field; rotation (`Sessions.ts:320-337`) never resets `createdAt`. A repo-wide grep for `reauthenticate` finds only the spec prose reference, no client implementation. Fix requires deciding whether to add an `authenticatedAt` field/`reauthenticate` mechanism end-to-end or amend the spec promise — a product/design call, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Step-up re-authentication mechanism (shared primitive)](../../.scratch/resolve-ready-for-human-findings/issues/15-step-up-reauth-mechanism.md) — Resolved via a new `authenticatedAt` field and `Sessions.reauthenticate` core primitive, with the qadi `reauthHandler` reading it instead of `createdAt`, and new per-credential discharge endpoints (`password`/`passkey` `reauthenticate`) that actually call it. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented the wayfinder ticket's design in full:

- `packages/core/src/Sessions.ts`: `SessionView`/`SessionRow`/`SessionListItem` all gain `authenticatedAt: DateTime.Utc` — set equal to `createdAt` at `issue` (every mint follows a real credential presentation), advanced only by a new `SessionsShape.reauthenticate(id)` method (implemented in both `layerMemory`/`layerSql`; does not rotate the secret/id or touch `idleExpiresAt`/`absoluteExpiresAt`). A new exported `isStale(authenticatedAt, maxAgeSeconds, now)` pure helper factors out the comparison.
- `packages/sql/src/Models.ts`/`CoreMigrations.ts`: `Session` model gains `authenticatedAt: Model.DateTimeUpdate`; migration 12 adds the column and backfills it from `createdAt` (a no-op today — no real deployment exists yet). `packages/sql/src/Repositories.ts`: `SessionsRepositoryShape` gains a targeted `reauthenticate` query (mirrors `tombstone`'s own shape).
- `packages/qadi/src/Resolvers.ts`: `reauthHandler` now compares `current.authenticatedAt` via `Sessions.isStale` instead of `current.createdAt` — closes the "un-dischargeable" half of this finding: a session can now genuinely refresh its own freshness without a full sign-out/sign-in.
- `packages/password/src/{Password,PasswordApi}.ts`: new authenticated `POST /password/reauthenticate` (payload: current password) — re-verifies via the same uniform-cost hash-comparison path `signIn`/`changePassword` use, then calls `Sessions.reauthenticate`. Rate-limited (mirrors `changePassword`'s numbers).
- `packages/passkey/src/{Passkey,PasskeyApi}.ts`: new authenticated `passkey.reauthenticate` group (`POST /passkey/reauthenticate/options` + `/verify`) — a WebAuthn authentication ceremony scoped to the caller's own already-live session (not a fresh sign-in), requiring UV=1 unconditionally, calling `Sessions.reauthenticate` on success. Also closes `BPAS-001` — see that finding's own resolution comment.
- `spec/appendices/02-qadi-path-a-end-to-end.md`: corrected the illustrative `client.session.reauthenticate` reference to the real, per-credential-package shape (`client.password.reauthenticate` / `client.passkey.reauthenticate`).

TDD: `packages/core/test/Sessions.test.ts` (authenticatedAt = createdAt at issue; `reauthenticate` advances it without touching the secret/expiry timestamps or failing for an unknown id; `isStale` boundary cases) against both `layerMemory`/`layerSql`; `packages/qadi/test/Resolvers.test.ts` adds the scenario this finding is actually about — a session minted long ago (stale `createdAt`) that was recently reauthenticated now discharges the obligation, which is exactly what the old `createdAt`-based comparison could never do. Verified to genuinely fail: reverting `reauthHandler`'s comparison back to `current.createdAt` reproduces a real `ReauthRequired` failure in that new test. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (684 passed, 7 skipped).
