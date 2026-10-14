---
"@awthaq/core": minor
"@awthaq/cli": minor
---

The pre-budget rate-limit path is removed (plan 06): every shipped plugin now declares a `rateLimitRules` table and spends it through `RateLimits.budget`.

Migration:
- Removed from `@awthaq/core`: `RateLimits.enforce`, `EnforceInput`, `EnforceMeta`, `RuleInput`, `RateLimitKey`, `registerDeclared`, `declarationDrift`/`DeclarationDrift`, `RateLimitsRegistry.register`, `AuthPlugin.declareRateLimits` and the `AuthPlugin.Service` option `rateLimits`. Declare rules with `rateLimitRules` and enforce with `RateLimits.budget(Self)` (`spend`, `guard`, `charge`); `docs/plugin-authoring.md` and `examples/plugin-template` show the shape. A plugin that declares rules and never opens its budget now fails at layer build (`RateLimitBudgetNotOpened`), and `spend`/`guard`/`charge` accept only declared names.
- `RateLimitsRegistry.registered` rows change: `key` is now the key strategy name (`"ip"`, `"email"`, `"user"`, ...) rather than a function, and rows gain `name`, `dimension`, `mode` and `bucket` (all required); `order` is a required number. A test that called `entry.key(input)` reads the consumed bucket through `RateLimits.bucketKey(rule, input)` instead.
- `RateLimitDeclaration` (and so `Manifest.rateLimits`) gains required `key` and `mode`.
- `awthaq plugin list --rules` prints KEY and MODE columns, and its JSON rows carry `key` and `mode`.
- Bucket keys are renamed to `ratelimit:<group>.<rule>:<strategy>:<value>` for every rule (see the per-plugin changesets for the old and new spellings). A deploy resets live counters once: rows in `RateLimiterStoreSql` expire within their window, at most one hour. Second-factor lockouts in progress are lifted (they last at most the 15-minute failure window).
