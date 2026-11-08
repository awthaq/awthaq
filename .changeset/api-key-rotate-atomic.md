---
"@awthaq/api-key": minor
---

API-key rotation and revocation are decided at the record-store write (plan 25 ticket 17, ADR-EA-041 decision 9):

- `ApiKey.rotate` no longer leaves a live successor of a key revoked while it ran. The successor is stored and the predecessor's expiry capped at `now + grace` (never lengthened) in one step, and only while the predecessor is neither revoked nor expired; a revoke that lands after the rotation read the key live wins, and the rotation answers `ApiKeyNotFound` with nothing stored.
- `ApiKey.revoke` publishes `auth.apiKey.revoked` only from the call that revoked the key: a repeated or concurrent revocation of the same key is a silent no-op (still `204`), so the audit log records one revocation.
- A reused key or client id is a defect on both adapters (the memory adapter used to overwrite the row; SQL used to answer `StoreUnavailable`).
- An `apikey_client` insert outage names `ApiKeyClientRecords.insert` in the 503 body, not `ApiKeyClientRecords.previousExpiresAt`.

Migration: a custom adapter through `@awthaq/api-key`'s `ApiKeyRecords` must implement `ApiKeyRecords.rotate({ predecessorId, successor, graceUntil, now })` atomically, answering `"rotated"` or `"notLive"` (memory: one `Ref.modify`; SQL: a conditional `UPDATE … WHERE "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > now) RETURNING id` and the insert in one transaction); `ApiKeyRecords.limitExpiry` is removed (its only caller was `rotate`). Migration: `ApiKeyRecords.revoke` now answers a `boolean`, `true` only for the call that set `revokedAt`. MOD-EA-007, BEH-EA-140, ADR-EA-022.
