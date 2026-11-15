---
"@awthaq/test": patch
---

`TestSql.layer` on Postgres now drops the layer's schema when its scope closes, instead of leaving one schema per layer build behind (a full run left about 840 of them, 650 MB, and made a second run on the same database slow enough to fail 5 s budgets), and its clients commit without waiting for the WAL flush. The `RateLimiterStore` contract's sweeper case waits for the sweeper's in-flight delete rather than reading straight after `TestClock.adjust`. No public surface changed; there is nothing to migrate.
