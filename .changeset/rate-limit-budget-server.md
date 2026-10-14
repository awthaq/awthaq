---
"@awthaq/server": minor
---

The account data export (`GET /user/export`) rate limit is declared and registered like a plugin's rule, under core's own owner `account` (`RateLimits.owner`, rule `exportData`, 5 per hour per user), and spent through `RateLimits.budget` (plan 06). It appears in `RateLimitsRegistry.registered`; it is not in `Auth.make(...).manifest.rateLimits`, which folds only plugins.

Migration: `AuthHttp.CoreHandlerServices` (and so `AuthHttp.coreHandlers`, `Account.AccountHandlers`) now requires `RateLimits.RateLimitsRegistry`. Every composition that installs a plugin already provides `RateLimits.layer`, and `TestAuth.layer` does; a host that served `coreHandlers` without any plugin adds `RateLimits.layer` once. The export bucket is renamed (`account:export:<userId>` becomes `ratelimit:account.exportData:user:<userId>`), so a deploy resets the live export counters once; entries in a shared store expire within one hour.
