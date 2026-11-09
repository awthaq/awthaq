---
"@awthaq/webhooks": patch
---

An event relayed while an endpoint is being deleted no longer leaves an orphaned delivery row: `WebhookRecords.enqueue` stores a row only while its endpoint exists (memory: inside the same `Ref.modify`; SQL: per row, a transaction that takes the endpoint row's key-share lock on Postgres before inserting). A custom `WebhookRecords` adapter should skip rows whose endpoint is gone in the same way (BEH-EA-281).
