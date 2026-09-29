# ADR-EA-028: Infrastructure Failures Are One Typed `StoreUnavailable`, Not Defects

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-028 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented for `Sessions` and `Verification`; rollout to `Users`, `Accounts` and `AuditLog` pending |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (MA-004, EEM-006) |

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

**Rollout**: `Sessions` (the hot path) and `Verification` are done. `Users`, `Accounts` and `AuditLog` still route `SqlError`/`SchemaError` through `Effect.orDie` and `Users.create` still surfaces the crypto `PlatformError`; converting them is mechanical with the same helper (`MA-004` stays open until then). A `Schedule`-based retry for `SQLITE_BUSY`/serialization failures on hot writes (SEA-002) builds on the typed error and is not part of this decision.

_Related: [ADR-EA-013](013-error-taxonomy-http-mapping.md), [BEH-EA-035](../behaviors/05-persistence-stratum.md#beh-ea-035-repositories-are-built-with-sqlmodelmakerepository-over-the-ambient-sqlclient-never-opening-their-own-transactions)._
