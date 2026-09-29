# ADR-EA-028: Infrastructure Failures Are One Typed `StoreUnavailable`, Not Defects

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-028 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented for `Sessions`, `Verification`, `Users`, `Accounts` and `AuditLog` |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (MA-004, EEM-006); 1.1 (2026-09-29): `AuditLog` converted, the audit-write failure policy, the transient-retry helper (MA-004, SEA-002) |

---

## Context

Core services fail in two different ways. A *domain* failure (`SessionNotFound`, `EmailAlreadyExists`, `TokenConsumed`) is an answer the caller is meant to handle, and it is a typed error in the service Shape's `E`. An *infrastructure* failure (a database that is down or busy, a connection pool that is exhausted, a crypto provider that cannot answer) had no policy: `layerSql` sent `SqlError` and `SchemaError` to the defect channel with `Effect.orDie` at some ninety call sites, `layerMemory` let the crypto `PlatformError` through as a typed error, and the Shape's declared `E` therefore described neither layer accurately. Callers paid for the inconsistency twice: nine plugin sites carried `catchTag("PlatformError", Effect.die)` to turn the typed error into a defect after the fact, and no caller could retry, fall back or answer 503, because a defect is invisible to a `catchTag`. The HTTP edge made the same choice de facto (NHS-002 turned a `verify` outage into a defect so it would stop answering 401), with no spec behind it.

## Decision

**Option B: one typed infrastructure error.** Every core Shape's `E` is its domain errors plus `StoreUnavailable`, and nothing else environmental.

1. **The class** is `StoreUnavailable` (`{ operation: string }`, HTTP 503), defined once in `@awthaq/api` and re-exported by `@awthaq/core` (`Errors.StoreUnavailable`). It is a `Schema.TaggedError` so the same class is the error a service fails with and the wire error a client decodes; there is no second `Data` twin to keep in step (ESS-008). Its cause is *not* a field. `Errors.storeUnavailable(operation)` logs the underlying `SqlError`/`PlatformError` once, where it happened, and fails with the label alone, so a database message can never reach a response body.
2. **What maps to it:** a `SqlError` from a repository and a `PlatformError` from `Crypto` (`layerSql` and `layerMemory` alike), applied at each service method's seam with `Effect.catchTags`.
3. **What still dies:** a `SchemaError` (a stored row no longer decodes, or a model was constructed with invalid input) and any invariant this code itself broke. Those are bugs a retry cannot fix.
4. **The HTTP edge:** `Authentication`, `AdminAuthentication`, `OptionalAuthentication` and `CsrfProtection` declare `StoreUnavailable` in their error lists, so every endpoint behind either accepts it without naming it, and the framework answers 503. `resolveSession` maps only `SessionNotFound`/`SessionExpired` to `Unauthenticated`. Because Effect's security chain falls through to the next scheme on any typed failure and answers with the last scheme's, the first scheme to see an outage records it against the request and every later scheme of that request fails with it, so the answer is 503 rather than the bearer scheme's "no credential" 401. `@awthaq/qadi`'s subject extractor reports it as `SubjectExtractionFailed`, the outage signal that error exists for.
5. **Callers** no longer carry `catchTag("PlatformError", Effect.die)`; a plugin Shape that composes a core service adds `StoreUnavailable` to its own `E`.

## Alternatives considered

**A: keep the de facto policy and write it down** (infrastructure failures are defects; remove `PlatformError` from every Shape by dying at the layer seam). Smallest change, but a caller can never retry a busy SQLite database or answer 503, and an operator's status-code alerting sees 500s that are indistinguishable from bugs.

**C: leave it per layer and document the difference.** Rejected: the Shape's `E` stays non-authoritative and a test that passes on `layerMemory` says nothing about how `layerSql` fails.

**A `Data.TaggedError` in core, mapped to a wire error at the edge.** Rejected: it doubles the tag, needs a mapping at every handler that composes a core service, and ESS-008 exists precisely because same-named internal and wire errors drift.

## Consequences

**Positive**: `E` is authoritative for both layers; an outage answers 503 (retryable, alertable) instead of 401 or 500; the nine `catchTag("PlatformError", Effect.die)` sites are gone; a caller such as a background job can retry with a `Schedule`.

**Negative**: every Shape that reaches a core service widens by one error, a one-time cascade through the plugin Shapes; `StoreUnavailable` is declared on the middleware rather than per endpoint, so a public endpoint behind neither cannot fail with it without declaring it itself (none does today).

**Rollout**: `Sessions` (the hot path), `Verification`, `VerificationLink`, `Users`, `Accounts` and `AuditLog` are done, in both layers (`Users.create`'s crypto `PlatformError` included). Every `AuditLog` method (`record`, `list`, `replay`, `pseudonymizeActor`, `purge`) fails with `StoreUnavailable` instead of dying; `DataExport`, `Retention` and `EventRelay` carry it in their own `E`.

## Audit-write failure policy (1.1)

`AuthEvents.publish` is `Effect<void>` and runs inline in nearly every operation, so what it does when `AuditLog.record` fails with `StoreUnavailable` is a policy, not an accident, and it is explicit: `AuthEvents.AuditWritePolicy`, read when the `AuthEvents` layer is built.

- **`"bestEffort"` (default).** The failure is logged at error level and counted (`awthaq_audit_write_failed_total{tag}`); the operation that published the event still succeeds and the bus still delivers the event. An outage of the audit table degrades the trail (the log line names the `eventId` and tag, so the gap is reconstructible) instead of turning every sign-in into an error after its own write has already committed. A store that is down for the operation itself fails that operation with `StoreUnavailable` in its own right.
- **`"required"`.** `publish` dies with the `StoreUnavailable`, so no security-relevant operation completes without its row (the behaviour before this decision, where the `orDie` was implicit). For a deployment whose audit obligation outranks availability: `AuthEvents.layer.pipe(Layer.provide(AuthEvents.auditWritePolicy("required")))`.

Widening `publish`'s `E` to `StoreUnavailable` was rejected: it would cascade through every service and plugin Shape for a failure the caller cannot act on (the operation it belongs to has already committed).

## Transient retry (1.1)

`Errors.retryTransient()` retries an effect while it fails with a *retryable* `SqlError` (`SQLITE_BUSY`/`SQLITE_LOCKED`, a Postgres deadlock or serialization failure, a lock or statement timeout, a dropped connection) up to three times on a jittered exponential schedule from 25 ms, and nothing else (constraint violations, `SchemaError`, defects are never retried). It wraps a whole unit of work: `Sessions.issue`'s statement or transaction and `Sessions.verify`'s idle-refresh touch (SEA-002). Once the retries are spent the last `SqlError` reaches the service's own `storeUnavailable(operation)`. See [the SQLite embedded-deployment appendix](../appendices/04-sqlite-embedded-deployment.md).

_Related: [ADR-EA-013](013-error-taxonomy-http-mapping.md), [BEH-EA-035](../behaviors/05-persistence-stratum.md#beh-ea-035-repositories-are-built-with-sqlmodelmakerepository-over-the-ambient-sqlclient-never-opening-their-own-transactions)._
