---
"@awthaq/core": minor
"@awthaq/qadi": minor
---

`@awthaq/qadi` owns its events (ADR-EA-049): the `auth.user.claimsUpdated` definition moved from `@awthaq/core` to `UserClaimsEvents`, is declared on the `UserClaims` plugin's `events`, and is published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `auth.authz.denied`, which qadi's decision logging publishes, stays in core.

Migration: `AuthEvents.UserClaimsUpdatedEvent` → `UserClaimsEvents.UserClaimsUpdatedEvent` from `@awthaq/qadi`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.user.claimsUpdated`: subscribe with `AuthEvents.on(UserClaimsEvents.UserClaimsUpdatedEvent, …)`, narrow the stream with `AuthEvents.is(UserClaimsEvents.UserClaimsUpdatedEvent)`, decode an audit row with `AuditLog.payloadAs(UserClaimsEvents.UserClaimsUpdatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(UserClaimsEvents.UserClaimsUpdatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
