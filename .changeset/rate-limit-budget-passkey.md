---
"@awthaq/passkey": patch
---

Passkey declares its three anonymous-ceremony rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06).

- TMS-006 tightening: the per-email `authenticateOptions` budget (10 per 15 minutes) now normalises case, whitespace and `+tag` through `RateLimits.Key.emailKey`, like password and magic link. Before, `victim+1@x.com` through `victim+N@x.com` each got a fresh budget, so an attacker could probe one address indefinitely.
- The registry now reports the keys that are actually enforced (the IP rules used to register the generic `"ip"` strategy while enforcing a different key).

Migration: rate-limit buckets are renamed (`passkey:authenticate-options:ip:<ip>` becomes `ratelimit:passkey.authenticate.authenticateOptionsByIp:ip:<ip>`, and likewise for the other two), so a deploy resets the live counters of these rules once; entries in a shared store expire within 15 minutes.
