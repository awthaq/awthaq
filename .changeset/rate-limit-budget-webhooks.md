---
"@awthaq/webhooks": patch
---

The webhooks admin group's per-administrator rate limit is declared as a `rateLimitRules` table and spent through `RateLimits.budget` (plan 06). It used to be enforced without being declared or registered; it now appears in `awthaq plugin list --rules`, the manifest and `RateLimitsRegistry.registered`. `WebhooksConfig.adminRate` is unchanged and still read per request (EP-007); the breach event still reports the admin action as its endpoint. Outbound delivery pacing (`webhooks:deliver:<endpointId>`) is unchanged: it shapes outbound traffic and stays a raw `RateLimiter.consume`.

Migration: the admin bucket is renamed (`webhooks:admin:<userId>` becomes `ratelimit:webhooks.admin.admin:user:<userId>`), so a deploy resets the live admin counters once; entries in a shared store expire within one minute.
