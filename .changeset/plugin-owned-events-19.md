---
"@awthaq/core": minor
"@awthaq/webhooks": minor
---

`@awthaq/webhooks` owns its events (ADR-EA-049): the five `auth.webhooks.*` definitions moved from `@awthaq/core` to `WebhookEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. An endpoint filter naming `auth.webhooks.*` resolves through the composed registry, which always holds them when webhooks serves.

Migration: `AuthEvents.WebhookEndpointCreatedEvent`, `AuthEvents.WebhookEndpointUpdatedEvent`, `AuthEvents.WebhookSecretRotatedEvent`, `AuthEvents.WebhookEndpointDeletedEvent` and `AuthEvents.WebhookTestQueuedEvent` → `WebhookEvents.<same name>` from `@awthaq/webhooks`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.webhooks.*`: subscribe with `AuthEvents.on(WebhookEvents.WebhookEndpointCreatedEvent, …)`, narrow the stream with `AuthEvents.is(WebhookEvents.WebhookEndpointCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(WebhookEvents.WebhookEndpointCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(WebhookEvents.WebhookEndpointCreatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
