---
"@awthaq/core": minor
"@awthaq/webhooks": patch
---

The audit log no longer needs the event set (ADR-EA-049). `AuditLog.record(event, definition)` writes an event through its own definition (core's when none is given): the actor column, and the fields it declares as personal data recorded with the row (`meta.pii`, only when it declares some; every other row is unchanged). A row whose tag core does not define is read as an `AuthEvents.ForeignEvent` (`{ _tag: "awthaq.foreignEvent", tag, fields }`) instead of failing with `AuditLogDecodeError`, so a removed plugin's history never stops `list`, `replay`, the relay or a data export; `AuditLog.payloadAs(definition)` decodes it. Erasure blanks a row's recorded `meta.pii`, and for rows written before this release the fields the three personal-data events declared then (`AuditLog.PRE_ADR_049_PII`). `toPublished` unwraps a foreign record, and the relay delivers it as published.

Migration: `AuditLogRecord.eventTag` is a `string`, and `payload` is `AuthEvent | AuthEvents.ForeignEvent`: narrow on `payload._tag`, or decode a plugin's row with `AuditLog.payloadAs(definition)`. `EventTransport.deliver` receives `ReadonlyArray<AuthEvents.PublishedAny>`. The tag filters of `AuditLog.list`/`replay`/`purge`, `EventRelay`'s `eventTag` and Retention's `AuditRetentionRule.tags` take `string`. `AuthEvents.encodeEvent` is removed (the audit log encodes through each event's definition: `Schema.encodeEffect(definition)`). `WebhookPayload.toBody`/`subjectUserId` accept `AuthEvents.PublishedAny`. ADR-EA-049, ADR-EA-029, ADR-EA-030, BEH-EA-100.
