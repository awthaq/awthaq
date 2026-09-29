# ADR-EA-027: Observability Reuses Effect's HTTP Middleware, Adds Business-Logic Spans and a Fixed Field Vocabulary, and Ships Metric Definitions Without a Backend

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-027 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (MW-001, EOTS-001/002/003/005/006, MAPS-007; wayfinder ticket 27) |

---

## Context

Before this decision the library had three log statements and no spans, metrics or field convention, and BEH-EA-199's "no `Redacted` value reaches a span or event" could only be honoured by review. Effect already ships a production-grade HTTP request tracer and logger; what it cannot see is the plain `Effect`s below the HTTP handler — session verification, password hashing, hook dispatch, event publication — and it cannot know which values are secrets.

## Decision

1. **HTTP layer: reuse, do not reimplement.** `AuthHttp.tracer` and `AuthHttp.requestLogger` are direct re-exports of `HttpMiddleware.tracer`/`logger`. `HttpRouter.serve` already logs one structured line per request; a host serving through `toWebHandler`, or running its own request logger, composes them explicitly (`AuthHttp.tracer(AuthHttp.requestLogger(app))`), never both. `AuthHttp.layerRedactedHeaders` keeps the rotated-token and JWT headers out of any logger.
2. **Business-logic spans**, named `awthaq.<domain>.<operation>`: `awthaq.session.verify`, `awthaq.session.issue`, `awthaq.password.<operation>` (with `awthaq.password.verify` around the hash check), `awthaq.oauth.callback`, `awthaq.passkey.authenticateVerify`, `awthaq.hook.dispatch`, `awthaq.event.publish`, `awthaq.event.handle` (a root span *linked* to the publishing span), and `awthaq.principal.resolve` at the shared session-resolution choke point of Path A and Path B. They nest under whatever span is active, so they compose with the HTTP tracer for free without depending on it.
3. **A fixed field vocabulary** (`Observability.Field`): `auth.event`, `auth.principal.type`, `auth.principal.ref`, `auth.session.id`, `auth.outcome` (`success | failure`), `auth.reason`, `auth.correlation_id`, `auth.hook`, `auth.strategy`. Applied with `annotateLogs`/`annotateCurrentSpan`, never interpolated into a message, so every field is queryable. **What may appear**: opaque ids (a user id, a *valid* session's id, an api-key id), event tags, fixed enums, provider ids from configuration. **What may not**: the session secret half or any whole token, a password or hash, an email address, a bearer/JWT, any `Redacted` value. A session id presented in a *rejected* credential is attacker-supplied input, so it is attached to a span only when id-shaped and bounded (`[A-Za-z0-9-]{1,64}`), and is never logged. `Observability.authSpan` accepts only `string | number | boolean` attributes, so a `Redacted` cannot be passed by accident.
4. **A small fixed metric taxonomy** as plain `Metric` values in `Observability.ts`, exported and left for the host to wire to OTLP/Prometheus: `awthaq_session_issued_total`, `awthaq_session_verify_failed_total{reason}` (`not-found | expired | unavailable`), `awthaq_session_verify_duration_seconds`, `awthaq_login_failed_total{strategy}`, `awthaq_event_dropped_total{tag}`, `awthaq_event_observer_error_total{tag}`, `awthaq_hook_observer_error_total{hook}`, `awthaq_event_subscriptions_active`, `awthaq_security_incident_total{rule}`. Labels are fixed enumerations, never caller input, so cardinality is bounded. (`awthaq.ratelimit.exceeded`, added earlier by EOTS-007, keeps its dotted name.) Two of these are counted at the single event choke point (`AuthEvents.publish`) rather than at every publisher.
5. **Observer failures log a sanitized summary** (`errorTag`, truncated message — never the error's data fields) at error level and the raw cause only at debug, through one helper (`logObserverFailure`), under the stable names `auth.hook.observer.error`, `auth.event.observer.error`, `auth.event.subscription.died`.
6. **BEH-EA-199 is mechanical.** `@awthaq/test`'s `RedactionGuard` installs a recording `Tracer`, a merged `Logger` and an `AuthEvents` inspector (all part of `TestAuth.layer`); a value leaks when it is any `Redacted` instance in the inspected structure, or a string containing a **canary** the test registered with `guard.watch(label, secret)`. `runPluginContractTests`' opt-in `redaction` option drives a plugin's flows against it. A leak names the channel, path and the canary's label — never the secret.

## Alternatives considered

**A bespoke `AuthObservability` logger/tracer.** Rejected: it would re-derive `HttpMiddleware` and bake a logging backend opinion into the library; the host owns sinks.

**Unbounded, per-event metrics.** Rejected: a metric per event tag or per identifier is a cardinality liability; the taxonomy is the small set an operator alerts on, and the audit log is the place for the long tail.

**Only checking `Redacted` instances.** Rejected: the leak that matters is the plaintext copy a `.value` unwrapped into an attribute or a message; canary matching is what catches it.

## Consequences

**Positive**: traces show where auth latency goes; every log/span line uses one vocabulary; redaction is a test that fails, not a review comment.

**Negative**: the recording tracer wraps every span in `TestAuth` compositions (negligible in tests); a host must still wire its own metrics/log backends; `awthaq_session_verify_failed_total` cannot distinguish a malformed token from an unknown id (both are `not-found`, by design).
