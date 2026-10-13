---
"@awthaq/two-factor": minor
---

Two-factor declares its rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06). The second-factor failure budget (BCR-006) keeps its own semantics (`SecondFactorLocked`, `auth.twoFactor.locked`, no `auth.rateLimit.exceeded`); only its bucket key comes from the shared rule, `SecondFactor.failureRule`.

- `manageByUser` breach events report the real endpoint (`enable`, `confirm`, `disable`, `regenerateRecoveryCodes`) instead of the catch-all `manage`.
- `failureBudget` reports `dimension: "principal"` (was `"identity"`), and any rule can be tuned with `RateLimits.overrides(RateLimits.tune(TwoFactor, { verifyByIp: { limit: 10 } }))`.

Migration: `SecondFactor.failureKey` is removed; use `RateLimits.bucketKey(SecondFactor.failureRule, { userId })`. Rate-limit buckets are renamed (`two_factor:fail:<userId>` becomes `ratelimit:two_factor.failures:user:<userId>`), so a deploy resets the live counters once and lifts any second-factor lockouts in progress (they last at most the 15-minute failure window).
