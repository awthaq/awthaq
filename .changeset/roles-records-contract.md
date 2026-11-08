---
"@awthaq/roles": patch
---

`RoleAssignments` has its first store-level suite, a RecordsContract suite (plan 25 ticket 24, ADR-EA-041 decision 9, F11): every operation carries a verdict, and `add`/`remove` are proven atomic and idempotent by 8-way race cases on memory and SQL, Postgres included under `pnpm test:pg`. No behaviour changes.
