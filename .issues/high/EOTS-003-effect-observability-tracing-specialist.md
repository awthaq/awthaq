---
ID: "EOTS-003"
Title: "Failed authentication attempts are completely unobservable"
Level: high
Category: "security"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:173"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-003 — Failed authentication attempts are completely unobservable

`HIGH` · `security` · `server` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **resolved**

## Summary

Every failed session verification — for every cookie/bearer request across all guarded endpoints — is collapsed to `Unauthenticated` with no log, no span attribute, and no event. The same holds in the password plugin: the `InvalidCredentials` failure (packages/password/src/Password.ts:539) publishes nothing while success publishes `auth.user.signedIn` (:560-564). INV-EA-010's rationale (spec/invariants.md:115: 'Without this, replay attempts are indistinguishable from ordinary invalid-token errors in any downstream monitoring, so an attacker probing stale links leaves no operational signal') applies verbatim to credential stuffing: the AuthEvent union has no sign-in-failure or session-verify-failure tag, so brute-force campaigns are invisible unless the host independently logs 401s. The rate limiter throttles per-email but does not emit any signal either (EOTS-007).

## Evidence

Source: `packages/server/src/Authentication.ts:173`

```
: sessions
            .verify(Redacted.make(raw))
            .pipe(Effect.mapError(() => new Api.Unauthenticated())),
```

## Recommended fix

Publish a typed failure event (`auth.user.signInFailed` carrying strategy and reason enum, no email in the payload — hash or bucket it) from password signIn, and log/annotate session-verify failures in `resolveSession` at debug level with the session id half only.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/server/src/Authentication.ts:172-175` (cited as :173) exactly; `Password.ts:539` fails `InvalidCredentials` with no event/log while the success path at :560-564 publishes `auth.user.signedIn`, and `grep -n "_tag:" packages/core/src/AuthEvents.ts` shows no sign-in-failure or session-verify-failure tag exists in the `AuthEvent` union. Adding a typed failure event + debug log is a mechanical, well-scoped fix. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `authn-failure-observability`. Already fixed by commit f5eb570. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:184`. Fix: The password half is fixed (f5eb570). Make session-verify failures observable in resolveSession without leaking credentials or session ids. (effort S). Full dossier: `.plan/slices/06-server-api.md`.

**Resolved (2026-09-29):** resolveSession logs one structured debug line 'awthaq: session verification failed' for every rejected non-empty credential (auth.event=session.verify.failed, auth.outcome=failure, auth.reason=<SessionNotFound|SessionExpired>, auth.scheme) and marks the current span auth.outcome=failure; never the credential or the (attacker-supplied) session id. An empty credential logs nothing. The metric is awthaq_session_verify_failed_total{reason} counted inside Sessions.verify (so every caller counts). No per-request AuthEvent (too noisy; reuse is already auth.session.reuse). Tests: Authentication.test.ts (log has reason and scheme but neither the secret nor the id; no-credential logs nothing) and Observability.test.ts (metric).
