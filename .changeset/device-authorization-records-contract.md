---
"@awthaq/device-authorization": patch
---

The device-authorization record stores have RecordsContract suites (plan 25 ticket 19, ADR-EA-041 decision 9):

- `DeviceGrantRecords`' compare-and-swap primitives (`claim`, `decide`, `raiseInterval`, `consume`) and `insert` are proven atomic by 8-way race cases on memory and SQL, Postgres included under `pnpm test:pg`. Before, they ran on memory only. `DeviceClientRecords` has its first adapter-level suite.
- The in-memory `DeviceGrantRecords.insert` refuses a taken grant id (`false`), as the SQL adapter already did. Before, it overwrote the row.
- A `DeviceGrantRecords.insert` outage is a `StoreUnavailable` with the operation `DeviceGrantRecords.insert`. Before, it was labelled `DeviceGrantRecords.amr`.

Migration: a custom adapter through `@awthaq/device-authorization`'s `DeviceGrantRecords` must answer `false` from `insert` when the grant id is taken, as well as when either code hash is, in one conditional write (memory: one `Ref.modify`; SQL: `INSERT … ON CONFLICT DO NOTHING RETURNING id`).
