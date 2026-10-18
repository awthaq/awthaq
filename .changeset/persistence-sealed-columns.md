---
"@awthaq/core": minor
---

`Persistence.sql(options)` provides `SealedColumn.Deployed`, the exact list of sealed columns that composition writes (three with `encryptPii` off, six with it on), built from the same options that choose its repositories. After a key rotation, `SealedColumn.sweepDeployed({ also: [...pluginColumns] })` re-seals them, so a retired key can finally be dropped for core rows nobody reads (ADR-EA-019 rev 1.3, BEH-EA-339).

Migration: replace a hand-built `SealedColumn.sweepAll` list of core columns with `SealedColumn.sweepDeployed()`; it is only available under `Persistence.sql(...)`, and never inside `TenantScope.withTenant`.
