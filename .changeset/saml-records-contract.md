---
"@awthaq/saml": patch
---

`SamlRecords` has a RecordsContract suite (plan 25 ticket 22, ADR-EA-041 decision 9, BEH-EA-315/318):

- A sign-in's SAML session row is one upsert (plan 24 C10). Before, `saveSession` deleted then inserted, so two saves of one session id could race into a primary-key failure (a `StoreUnavailable`), and a reader between the statements saw no row.
- A connection and its email domains are written as one step: the SQL `create`, `update` and `remove` each run in one transaction, the connection row first. A taken domain rolls the whole write back (no compensating delete), an update no longer writes the row of a connection removed meanwhile, and an update racing a removal cannot deadlock on Postgres.
- `emailDomains` are answered in ascending order by both adapters (plan 24 R5); the memory adapter kept insertion order.
- Every operation carries a verdict, with 8-way race cases for `create`, `update`, `remove` and `saveSession` on memory and SQL, Postgres included under `pnpm test:pg`.

Migration: a custom adapter through `@awthaq/saml`'s `SamlRecords` must answer `emailDomains` ascending, make `saveSession` a single upsert, and write a connection with its domains atomically (a taken domain leaves nothing of the create or update).
