---
"@awthaq/core": minor
"@awthaq/saml": minor
---

`@awthaq/saml` owns its events (ADR-EA-049): the five definitions `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated, logoutRejected}` moved from `@awthaq/core` to `SamlEvents`, are declared on the `Saml` plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `auth.admin.actionDenied`, which saml also publishes, stays in core.

Migration: `AuthEvents.SamlConnectionCreatedEvent`, `AuthEvents.SamlConnectionUpdatedEvent`, `AuthEvents.SamlConnectionDeletedEvent`, `AuthEvents.SamlSigningKeyRotatedEvent` and `AuthEvents.SamlLogoutRejectedEvent` → `SamlEvents.<same name>` from `@awthaq/saml`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.saml.*`: subscribe with `AuthEvents.on(SamlEvents.SamlConnectionCreatedEvent, …)`, narrow the stream with `AuthEvents.is(SamlEvents.SamlConnectionCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(SamlEvents.SamlConnectionCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(SamlEvents.SamlConnectionCreatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
