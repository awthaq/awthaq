---
"@awthaq/device-authorization": minor
---

Device authorization declares its nine rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06). `DeviceAuthorizationConfig.codeRateLimit`, `userCodeRateLimit` and `invalidGrantRateLimit` keep working: they tune the declared defaults.

- A refused failure-budget lookup (`guard`) is now also logged and counted in `awthaq.ratelimit.exceeded`, like every other breach (it used to publish the event only).
- `code-client` breaches report `dimension: "identity"` (was `"custom"`).

Migration: rule labels are renamed (they appear in `auth.rateLimit.exceeded.rule`, in the `awthaq.ratelimit.exceeded` metric and in `plugin list --rules`): `code-ip` is `codeByIp`, `code-client` is `codeByClient`, `token-invalid-ip` is `invalidGrantByIp`, `verify-ip`/`approve-ip`/`deny-ip` are `verifyByIp`/`approveByIp`/`denyByIp` and `verify-session`/`approve-session`/`deny-session` are `verifyBySession`/`approveBySession`/`denyBySession`. Rate-limit buckets are renamed too (`device:code:ip:<ip>` becomes `ratelimit:device_authorization.codeByIp:ip:<ip>`, and the shared user-code lookups use `ratelimit:device_authorization.userCode:ip:<ip>` / `:session:<id>`), so a deploy resets the live counters once; entries in a shared store expire within 15 minutes.
