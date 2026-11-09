---
"@awthaq/core": minor
"@awthaq/roles": minor
---

`@awthaq/roles` owns its events (ADR-EA-049): the two `auth.roles.*` definitions moved from `@awthaq/core` to `RolesEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged.

Migration: `AuthEvents.RolesAssignedEvent` and `AuthEvents.RolesRevokedEvent` → `RolesEvents.<same name>` from `@awthaq/roles`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.roles.*`: subscribe with `AuthEvents.on(RolesEvents.RolesAssignedEvent, …)`, narrow the stream with `AuthEvents.is(RolesEvents.RolesAssignedEvent)`, decode an audit row with `AuditLog.payloadAs(RolesEvents.RolesAssignedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(RolesEvents.RolesAssignedEvent)(e)`. ADR-EA-049, BEH-EA-101.
