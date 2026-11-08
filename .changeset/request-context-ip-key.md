---
"@awthaq/core": minor
---

The `ip` rate-limit strategy is sealed (ADR-EA-047). `RateLimits.Key.ip` takes no input: it reads the request's address from `Api.AuthRequestContext`, so `spend("xByIp", { ip })` is a compile error and a spend, guard or charge of an ip-keyed rule names `Api.AuthRequestContext` in its requirements (`RateLimits.RequiresOf`). Under `noRequest` an ip-keyed rule does not apply (the identity and principal rules still do); a request with no resolvable address shares the `ip:unknown` bucket. `spend`'s input may be left out when every named rule reads nothing from it. `Key.part` and `Rule.keyOf` return an `Option`, `Key<I, R>`/`Rule<…, R>` carry the requirement, and `RateLimits.bucketKey` accepts only a rule whose key reads no request. `VerificationLink.redeemer`'s `budget.source` is an `Effect` (no `ip` argument) and the presented token carries no `ip`.

Migration: replace `limits.spend("xByIp", { ip })` with `limits.spend("xByIp")` (and drop `ip` from a combined input); provide `Api.AuthRequestContext` where the spend runs. A custom key returns `Option.some(part)` from `part`. `source: (ip) => limits.spend("xByIp", { ip })` becomes `source: limits.spend("xByIp")`.
