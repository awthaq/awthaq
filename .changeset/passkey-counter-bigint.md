---
"@awthaq/passkey": minor
---

The stored signature counter accepts the full WebAuthn range (up to 2^32 - 1) on Postgres; a new migration `widen_passkey_credential_counter` widens the column to `BIGINT` (a no-op on SQLite) (BEH-EA-131).

Migration: run the plugin migrations. On a large `passkey_credential` table the `ALTER COLUMN … TYPE BIGINT` rewrites the table under an exclusive lock; schedule it.
