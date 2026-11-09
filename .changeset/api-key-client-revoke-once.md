---
"@awthaq/api-key": patch
---

`revokeClient` publishes `auth.apiKey.clientRevoked` only from the call that revoked the client: revoking an already-revoked client (or losing a concurrent revocation) is a silent no-op, as `revoke` already is for keys. `ApiKeyClientRecords.revoke` now answers a `boolean` (whether this call revoked the client); a custom `ApiKeyClientRecords` adapter returns `true` only when it set `revokedAt`.
