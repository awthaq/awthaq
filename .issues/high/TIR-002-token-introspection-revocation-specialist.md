---
ID: "TIR-002"
Title: "verifyLive ignores idle expiry - an idle-expired session still passes the live check"
Level: high
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:288"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-002 — verifyLive ignores idle expiry - an idle-expired session still passes the live check

`HIGH` · `correctness` · `jwt` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **resolved**

## Summary

verifyLive's doc claims it checks the sid 'still names an unrevoked, unexpired session', but SessionListItem.expiresAt is absoluteExpiresAt (packages/core/src/Sessions.ts:391 and :576), so the check sees only the absolute deadline. A session that idle-expired days ago - dead per Sessions.verify's idleExpiresAt comparison (Sessions.ts:283-287) - still passes verifyLive as long as absolute expiry is in the future. Any application that wires verifyLive for revocation enforcement inherits a live-check that is wrong by half of the expiry model, silently extending idle-dead sessions' JWT lifetimes up to the full absolute TTL.

## Evidence

Source: `packages/jwt/src/Jwt.ts:288`

```
  (row) =>
    row.id === Sessions.SessionId(sid) &&
    DateTime.toEpochMillis(row.expiresAt) > DateTime.toEpochMillis(now),
```

## Recommended fix

Expose both deadlines on SessionListItem (or add a dedicated Sessions.isLive(sid) that applies the exact absolute+idle logic of Sessions.verify) and test both expiries in packages/jwt/test/Jwt.test.ts's verifyLive suite.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `verifyLive` (`packages/jwt/src/Jwt.ts:288`) compares only `row.expiresAt`, which both `Sessions.ts` layers populate as `row.absoluteExpiresAt` (memory list at `:391`, SQL list at `:576`), while `Sessions.verify` (`Sessions.ts:283-287`) checks both `absoluteExpiresAt` and `idleExpiresAt`. Evidence quote matches current code exactly. Fix is a well-scoped, mechanical change (expose idle deadline or add `Sessions.isLive`). Status → ready-for-agent.

**Resolved (2026-09-19):** Took the recommended fix's second option — added `Sessions.isLive(userId, id): Effect.Effect<boolean>` to `SessionsShape` (`packages/core/src/Sessions.ts`), implemented identically in both `layerMemory` and `layerSql`: a single keyed lookup (not `list`'s per-user scan) applying `verify`'s own exact logic — tombstone check, then both `absoluteExpiresAt` and `idleExpiresAt` against `now` — without `verify`'s secret comparison, throttled touch, or rotation, since this never authenticates the caller. `userId` is checked too, preserving the guarantee that a JWT's `sub` actually owns the `sid` it names.

`Jwt.ts`'s `sidStillLive` (shared by `verifyLive`/`introspectLive`, TIR-001) now calls `sessions.isLive(...)` directly instead of `sessions.list(...)` + a manual scan against `SessionListItem.expiresAt` — this single change also fully satisfies FAMS-009 and MAPS-006 (same evidence line, same file, both recommending this exact keyed-lookup architecture), resolved together in this commit.

TDD: `packages/jwt/test/Jwt.test.ts` gained a `verifyLive` test using a custom `ttl` override plus the session's default 7-day idle / 30-day absolute config — advances `TestClock` 8 days (idle-expired, nowhere near absolute-expired) and asserts `verifyLive` fails with `reason: "session no longer live"` specifically (not just any `JwtInvalidError`, which a shorter-lived JWT's own basic expiry could also produce). `packages/core/test/Sessions.test.ts` gained 4 direct `isLive` tests (idle-expired-but-absolute-live via the existing `shortLivedLayer`; freshly-issued-and-live; wrong-`userId`; unknown-id), run against both `layerMemory` and `layerSql` via the file's existing `suite` helper. Verified two genuine fail/pass cycles: reverting the idle-expiry check reproduces exactly the idle-expiry test failures (both files); separately reverting the `userId` ownership check reproduces exactly the wrong-`userId` test's failure. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (659 passed, 7 skipped).
