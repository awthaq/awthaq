---
"@awthaq/sql": patch
"@awthaq/organization": patch
"@awthaq/test": patch
---

Postgres: racing session inserts and step-ups no longer overshoot or exhaust under contention, and a domain claim's writes stay under row-level security.

- `@awthaq/sql`: `SessionStore.insert` with a `maxLive` cap takes a per-user advisory transaction lock, so concurrent logins serialize and the cap holds exactly (SMS-003); `SessionStore.reauthenticate` takes a per-session lock, so N concurrent step-ups all land (THS-003).
- `@awthaq/organization`: `DomainClaims.claim` lifts row-level security only for the owner read, not for its inserts and deletes.
- `@awthaq/test`: `TestSql.prepareRlsProbe` readies a suite's schema for an RLS probe; `runTenantIsolationTests` uses it.
