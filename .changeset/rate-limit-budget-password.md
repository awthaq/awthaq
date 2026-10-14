---
"@awthaq/password": patch
---

The password plugin declares its 17 rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06). The limits and windows are unchanged, and `plugin list --rules` now also prints each rule's key strategy and mode. Any shipped rule can be tuned or opted into escalation with `RateLimits.overrides(RateLimits.tune(Password, { signIn: { limit: 3 } }))`.

- `PasswordConfig.rateLimitEmailKey` now defaults to `RateLimits.Key.emailKey`, which also trims whitespace (it only lower-cased and stripped `+tag` before).
- `changePassword`, `reauthenticate` and `changeEmail` breaches report `dimension: "principal"` (was `"identity"`): they key on the signed-in user.

Migration: rate-limit buckets are renamed (`password:signin:<email>` becomes `ratelimit:password.signIn:email:<email>`, `password:signin:ip:<ip>` becomes `ratelimit:password.signInByIp:ip:<ip>`, and likewise for every rule), so a deploy resets the live counters of these rules once; entries in a shared store expire within one hour. Dashboards that filter `auth.rateLimit.exceeded` on `dimension: "identity"` for those three rules should also match `"principal"`.
