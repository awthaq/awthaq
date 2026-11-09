---
"@awthaq/core": minor
"@awthaq/two-factor": minor
---

`@awthaq/two-factor` owns its events (ADR-EA-049): the seven `auth.twoFactor.*` definitions moved from `@awthaq/core` to `TwoFactorEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. The package's `SecondFactor` module emits them. The `TwoFactorMethod` and `TwoFactorPurpose` schemas they use move with them.

Migration: `AuthEvents.TwoFactorEnabledEvent`, `AuthEvents.TwoFactorDisabledEvent`, `AuthEvents.TwoFactorVerifiedEvent`, `AuthEvents.TwoFactorChallengeFailedEvent`, `AuthEvents.TwoFactorRecoveryCodeUsedEvent`, `AuthEvents.TwoFactorRecoveryCodesRegeneratedEvent` and `AuthEvents.TwoFactorLockedEvent` (and `AuthEvents.TwoFactorMethod`, `AuthEvents.TwoFactorPurpose`) → `TwoFactorEvents.<same name>` from `@awthaq/two-factor`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.twoFactor.*`: subscribe with `AuthEvents.on(TwoFactorEvents.TwoFactorEnabledEvent, …)`, narrow the stream with `AuthEvents.is(TwoFactorEvents.TwoFactorEnabledEvent)`, decode an audit row with `AuditLog.payloadAs(TwoFactorEvents.TwoFactorEnabledEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(TwoFactorEvents.TwoFactorEnabledEvent)(e)`. ADR-EA-049, BEH-EA-101.
