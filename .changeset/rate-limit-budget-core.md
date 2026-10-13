---
"@awthaq/core": minor
---

Rate-limit rules are declared once and spent by name (BEH-EA-105 to BEH-EA-111, plan 06).

`AuthPlugin.Service(id, { rateLimitRules: { name: RateLimits.rule({ group, endpoint, key: RateLimits.Key.ip, limit, window }) } })` declares a typed table (`RateLimits.failureRule` for a BCR-006 failure budget). The static `rateLimits` listing (`plugin list --rules`) is derived from it and gains `key` and `mode`. `yield* RateLimits.budget(Self, { tune, emailKey })` in `make` registers the table and returns a handle: `spend(names, input)`, `guard` and `charge`. The compiler checks the names and the input shape, and a rule naming a group outside the plugin's contract is a compile error. A breach is published, logged, counted and answered with `Api.RateLimited`. `RateLimits.budgetOf(Self)` gets the handle elsewhere (handlers, credential contributions). `RateLimits.overrides(RateLimits.tune(Plugin, { rule: { limit, window, escalation } }))` tunes any shipped rule, and `RateLimitOverrides` can be provided per fiber (a tenant) and wins. `AuthPlugin.layer` refuses a plugin that declares rules but never opens its budget (`RateLimitBudgetNotOpened`). `RateLimits.Key` holds the key strategies (`ip`, `email`, `identifier`, `user`, `session`, `client`, `phone`, `custom`) and the one email normaliser `Key.emailKey`.

Migration:
- `RateLimits.rule(owner, input)` (the registry `Layer`) is now the rule constructor; declare the rule in the plugin's `rateLimitRules` table and open `RateLimits.budget(owner)` instead.
- `RateLimits.bucketKey(rule, input?)` with `"ip"` or `"principal"` becomes `RateLimits.bucketKey(rule, input)` over a rule built from `RateLimits.Key.*` that names an explicit `bucket`; the caller passes `{ ip }` or `{ userId }` (the handler resolves them, there is no ambient read any more).
- `RateLimits.enforceRule` is removed: use `budget(...).spend`.
- `RateLimits.phoneKey(read, options)` is removed: use `RateLimits.Key.phone(options)`, which reads `{ phone }`.
- Bucket keys for rules moved to a budget are renamed to `ratelimit:<bucket>:<part>`; the first deploy resets the live counters of those rules (rows in a shared `RateLimiterStore` expire within their window, at most one hour). See the per-plugin changesets.
