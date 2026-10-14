---
"@awthaq/core": minor
"@awthaq/webhooks": patch
---
An event's actor and personal-data fields are declared with its schema (`defineEvent(tag, fields, { actor, pii })` inside core), and the audit trail reads them from there instead of a 92-case switch and a separate `PII_FIELDS` table. New: `AuthEvents.eventTags` (every publishable tag), `AuthEvents.actorOf(event)` (who acted, as the audit row records it), `AuthEvents.piiFieldsOf(tag)`. Fixed: the in-memory `AuditLog`'s erasure no longer blanks free text on rows that do not name the erased user. No change to any stored or delivered payload.

Migration: `AuthEvents.PII_FIELDS` is removed; replace `AuthEvents.PII_FIELDS[tag] ?? []` with `AuthEvents.piiFieldsOf(tag)`. ADR-EA-029 (rev 1.1), BEH-EA-101, BEH-EA-277.
