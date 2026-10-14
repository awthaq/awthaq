---
"@awthaq/oauth": patch
---

OAuth declares its three rate-limit rules (`authorize`, `callback`, `token`) as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06). `OAuthConfig.rateLimits` is unchanged and still read per request, so a tenant's `OAuth.config(...)` still tunes the limits (EP-007). The registry now reports the keys that are actually enforced (it used to register the generic `"ip"` strategy while enforcing `oauth:<endpoint>:<ip>`), and any rule can also be tuned with `RateLimits.overrides(RateLimits.tune(OAuth, { callback: { limit: 10 } }))`. No API change.

Migration: rate-limit buckets are renamed (`oauth:authorize:<ip>` becomes `ratelimit:oauth.authorize:ip:<ip>`, `oauth:callback:<ip>` becomes `ratelimit:oauth.callback:ip:<ip>`, `oauth:token:<ip>` becomes `ratelimit:oauth.exchange.token:ip:<ip>`), so a deploy resets the live counters once; entries in a shared store expire within one minute.
