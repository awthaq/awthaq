---
"@awthaq/core": minor
"@awthaq/password": minor
---

`@awthaq/password` owns its events (ADR-EA-049): the four definitions `auth.user.emailVerified`, `auth.user.emailChanged`, `auth.password.resetRequested` and `auth.password.resetCompleted` moved from `@awthaq/core` to `PasswordEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `auth.password.changed` stays in core: `@awthaq/admin` publishes it too.

Migration: `AuthEvents.UserEmailVerifiedEvent`, `AuthEvents.UserEmailChangedEvent`, `AuthEvents.PasswordResetRequestedEvent` and `AuthEvents.PasswordResetCompletedEvent` → `PasswordEvents.<same name>` from `@awthaq/password`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include these four tags: subscribe with `AuthEvents.on(PasswordEvents.UserEmailVerifiedEvent, …)`, narrow the stream with `AuthEvents.is(PasswordEvents.UserEmailVerifiedEvent)`, decode an audit row with `AuditLog.payloadAs(PasswordEvents.UserEmailVerifiedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(PasswordEvents.UserEmailVerifiedEvent)(e)`. ADR-EA-049, BEH-EA-101.
