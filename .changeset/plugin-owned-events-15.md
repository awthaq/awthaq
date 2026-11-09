---
"@awthaq/core": minor
"@awthaq/api-key": minor
---

`@awthaq/api-key` owns its events (ADR-EA-049): the six `auth.apiKey.*` definitions moved from `@awthaq/core` to `ApiKeyEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged.

Migration: `AuthEvents.ApiKeyCreatedEvent`, `AuthEvents.ApiKeyRevokedEvent`, `AuthEvents.ApiKeyRotatedEvent`, `AuthEvents.ApiKeyClientRegisteredEvent`, `AuthEvents.ApiKeyClientRevokedEvent` and `AuthEvents.ApiKeyClientSecretRotatedEvent` → `ApiKeyEvents.<same name>` from `@awthaq/api-key`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.apiKey.*`: subscribe with `AuthEvents.on(ApiKeyEvents.ApiKeyCreatedEvent, …)`, narrow the stream with `AuthEvents.is(ApiKeyEvents.ApiKeyCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(ApiKeyEvents.ApiKeyCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(ApiKeyEvents.ApiKeyCreatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
