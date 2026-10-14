---
"@awthaq/api-key": minor
---

API keys declare their three rate-limit rules as a `rateLimitRules` table and spend them through `RateLimits.budget` / `RateLimits.budgetOf(ApiKey)` (plan 06). `ApiKeyConfig.tokenRateLimit` and `resolveRateLimit` are unchanged and tune the declared defaults. The registry now reports the keys that are actually enforced (it used to register the per-client rule as the literal `apikey:token:client:[object Object]` and the IP rules as the generic `"ip"`), and any rule can also be tuned with `RateLimits.overrides(RateLimits.tune(ApiKey, { tokenByClient: { limit: 10 } }))`.

Migration: rule labels are renamed (they appear in `auth.rateLimit.exceeded.rule`, the `awthaq.ratelimit.exceeded` metric and `plugin list --rules`): `token-ip` is `tokenByIp`, `token-client` is `tokenByClient` (and reports `dimension: "identity"`, was `"custom"`), `resolve-ip` is `resolveByIp`. Rate-limit buckets are renamed too (`apikey:token:ip:<ip>` becomes `ratelimit:apikey.token.tokenByIp:ip:<ip>`, `apikey:token:client:<id>` becomes `ratelimit:apikey.token.tokenByClient:client:<id>`, `apikey:resolve:ip:<ip>` becomes `ratelimit:apikey.resolveByIp:ip:<ip>`), so a deploy resets the live counters once; entries in a shared store expire within one minute.
