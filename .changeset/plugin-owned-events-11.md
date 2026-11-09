---
"@awthaq/core": minor
"@awthaq/device-authorization": minor
---

`@awthaq/device-authorization` owns its events (ADR-EA-049): the two `auth.deviceAuthorization.*` definitions moved from `@awthaq/core` to `DeviceAuthorizationEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged.

Migration: `AuthEvents.DeviceAuthorizationApprovedEvent` and `AuthEvents.DeviceAuthorizationDeniedEvent` → `DeviceAuthorizationEvents.<same name>` from `@awthaq/device-authorization`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.deviceAuthorization.*`: subscribe with `AuthEvents.on(DeviceAuthorizationEvents.DeviceAuthorizationApprovedEvent, …)`, narrow the stream with `AuthEvents.is(DeviceAuthorizationEvents.DeviceAuthorizationApprovedEvent)`, decode an audit row with `AuditLog.payloadAs(DeviceAuthorizationEvents.DeviceAuthorizationApprovedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(DeviceAuthorizationEvents.DeviceAuthorizationApprovedEvent)(e)`. ADR-EA-049, BEH-EA-101.
