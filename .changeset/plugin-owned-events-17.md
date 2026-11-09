---
"@awthaq/core": minor
"@awthaq/scim": minor
---

`@awthaq/scim` owns its events (ADR-EA-049): the five `auth.scim.*` definitions moved from `@awthaq/core` to `ScimEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged.

Migration: `AuthEvents.ScimUserProvisionedEvent`, `AuthEvents.ScimUserDeactivatedEvent`, `AuthEvents.ScimUserReactivatedEvent`, `AuthEvents.ScimUserDeletedEvent` and `AuthEvents.ScimGroupChangedEvent` → `ScimEvents.<same name>` from `@awthaq/scim`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.scim.*`: subscribe with `AuthEvents.on(ScimEvents.ScimUserProvisionedEvent, …)`, narrow the stream with `AuthEvents.is(ScimEvents.ScimUserProvisionedEvent)`, decode an audit row with `AuditLog.payloadAs(ScimEvents.ScimUserProvisionedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(ScimEvents.ScimUserProvisionedEvent)(e)`. ADR-EA-049, BEH-EA-101.
