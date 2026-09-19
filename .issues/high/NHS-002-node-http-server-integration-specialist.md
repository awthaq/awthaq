---
ID: "NHS-002"
Title: "Session-verify infrastructure failures are mapped to 401 Unauthenticated"
Level: high
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:175"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-002 — Session-verify infrastructure failures are mapped to 401 Unauthenticated

`HIGH` · `correctness` · `server` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

Sessions.verify fails with SessionNotFound | SessionExpired | PlatformError.PlatformError (packages/core/src/Sessions.ts:188), and the middleware collapses all three into Api.Unauthenticated. A database outage therefore answers 401 on every request: logged-in clients look logged out and re-storm the login endpoints, dashboards and alerting keyed on status codes see an authentication problem instead of a 5xx incident, and RFC semantics are violated (401 claims the credential is wrong when the server is broken). Because qadi's SubjectExtractor funnels through the same resolveSession, the conflation propagates there too.

## Evidence

Source: `packages/server/src/Authentication.ts:175`

```
.verify(Redacted.make(raw))
            .pipe(Effect.mapError(() => new Api.Unauthenticated())),
```

## Recommended fix

Match on the failure tag inside resolveSession: keep Unauthenticated for SessionNotFound/SessionExpired, and rethrow or map PlatformError to a dedicated 503-class contract error so infrastructure health is observable and clients are not told to re-authenticate.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/server/src/Authentication.ts:174-175` still blanket-maps every `sessions.verify` failure to `Api.Unauthenticated` via `Effect.mapError(() => new Api.Unauthenticated())`, and `packages/core/src/Sessions.ts:184-189` confirms `verify`'s declared error union is `SessionNotFound | SessionExpired | PlatformError.PlatformError`, so a backing-store outage is indistinguishable from a bad credential. The fix (discriminate by tag, e.g. `Effect.catchTags` for the two session-specific tags and `Effect.orDie`/a dedicated error for `PlatformError`) is confined to this one function and doesn't require touching `packages/api/src/Api.ts`'s middleware contract. Status → ready-for-agent.

**Resolved (2026-09-20):** `resolveSession` (`packages/server/src/Authentication.ts`) now runs `Effect.catchTag("PlatformError", Effect.die)` **before** `Effect.mapError(() => new Api.Unauthenticated())` — this exact ordering matters and was itself the subject of a self-caught bug during this fix (see TDD note below). `PlatformError` (a real backing-store outage) now dies into a defect, reported as a server error by the framework's own default handling; only `SessionNotFound`/`SessionExpired` still map to `Unauthenticated`. No new contract error type was needed — `Api.Authentication`'s middleware signature is untouched, matching the validation note's own scope call. `EEM-003` (same file, same evidence, identical recommended fix) closed alongside this as a duplicate.

Also fixed the propagation the finding calls out: `@awthaq/qadi`'s `SubjectExtractor.ts` calls `resolvePrincipal`, which itself calls this same `resolveSession` — so it now also dies on a backing-store outage instead of silently reporting an anonymous caller. Its own stale doc comment (previously documenting the old, uniform-collapse behavior as deliberate) is updated to describe the corrected behavior. `packages/next/src/GetSession.ts` already got this right (`Effect.catchTags` for the two session tags only, `PlatformError` left to propagate) — no change needed there, and it served as a second working precedent for the fix.

TDD: `packages/server/test/Authentication.test.ts` gained a fake `Sessions` layer whose `verify` always fails with a real `PlatformError.systemError(...)`, and a test calling `Authentication.resolveSession` directly, asserting via `Effect.exit`/`Cause.hasDies`/`Cause.hasFails` that the result is a genuine die, not a failure. Verified to genuinely fail with the fix reverted (outage resolved to a plain `Unauthenticated` failure, not a die). Caught a real bug in the *first* attempt at this fix during the mandated full-suite run (not the isolated test): `Effect.catchTags({SessionNotFound: ..., SessionExpired: ...})` followed by a blanket `.pipe(Effect.orDie)` also died the just-re-thrown `Unauthenticated` failure itself, since `orDie` doesn't discriminate by tag — it dies on *any* remaining failure, including one the previous step just produced. Five existing tests (`SubjectExtractor.test.ts` ×1, `AuthHttp.test.ts` ×4) caught this immediately. Fixed by switching to the `catchTag("PlatformError", Effect.die)`-then-`mapError` ordering instead, matching this codebase's own established idiom already used in `OAuth.ts`/`Password.ts`. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (667 passed, 7 skipped).
