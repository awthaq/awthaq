---
"@awthaq/magic-link": minor
---

Magic link and email OTP declare their rate-limit rules as a `rateLimitRules` table and spend them through `RateLimits.budget` (plan 06). Behaviour is unchanged apart from the bucket key spelling, and every `+tag` alias of an address still shares one budget (now through `RateLimits.Key.emailKey`).

Migration: `Channel.emailRateKey` is removed; use `RateLimits.Key.emailKey` from `@awthaq/core`. Rate-limit buckets are renamed (`magic-link:request:ip:<ip>` becomes `ratelimit:magicLink.requestByIp:ip:<ip>`, and likewise for email OTP), so a deploy resets the live counters of these rules once; entries in a shared store expire within 15 minutes.
