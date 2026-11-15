---
"@awthaq/sql": minor
"@awthaq/test": patch
"@awthaq/core": patch
---

`CoreTables` in `@awthaq/sql` is the one declared list of the core tables: per table its name, owner `core`, tenancy (`partitioned`, `directory` or `none`), whether the test-side `LaggingReplica` mirrors it, and its sealed columns as a view over `CoreSealedColumns` (no column types, no DDL). It classifies `auth_relay_cursor` and `rate_limit_buckets` (no tenant column, never mirrored, each with its reason). `TenantScope.partitionedTables` and `directoryTables`, `Auth.make`'s Derived-parent check and `LaggingReplica.coreTables` now read it; their values, order, RLS coverage and the sealed AADs are unchanged. The `Auth/TenancyDeclarationInvalid` `UnknownParent` message now says "tenant-stamped core table".

Migration: `TenantScope.partitionedTables` and `TenantScope.directoryTables` are now typed `ReadonlyArray` of their table-name literals instead of readonly tuples, so code that indexes them by a fixed position or relies on their tuple length must widen; values and order are unchanged. `LaggingReplica.coreTables` keeps its name, type and order. No data or schema migration.
