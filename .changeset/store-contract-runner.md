---
"@awthaq/test": minor
---

`StoreContract` takes `RecordsContract`'s shape (architecture plan 37, ADR-EA-041 rev 1.6). Every core store port is a suite whose operations carry verdicts, and one without a verdict does not compile. `StoreContract.run(framework, mode)` owns the memory, SQL and sealed modes. `RateLimiterStore` joins as `rateLimiterStore`.

Migration: `StoreContract.<port>` is a `Suite`, not a `ReadonlyArray` of cases. `StoreContract.run(framework, { adapter, layer, cases })` is now `StoreContract.runSuite(framework, { adapter, suite, layer })`, and `StoreContract.run(framework, mode)` runs every suite on a mode's shipped adapters. A caller that ran the core contract on its own adapter passes the port's suite.
