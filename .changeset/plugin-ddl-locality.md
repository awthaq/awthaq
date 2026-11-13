---
"@awthaq/two-factor": patch
"@awthaq/qadi": patch
"@awthaq/roles": patch
---

Each table's migrations moved into its records module and are written once for both dialects. Migration names and order are unchanged; an already-migrated database applies nothing new and `awthaq migration status` reports no drift. Plugin indexes are created `IF NOT EXISTS` (SSMS-006), so an index built `CONCURRENTLY` beforehand no longer fails the deploy.

Migration: none.
