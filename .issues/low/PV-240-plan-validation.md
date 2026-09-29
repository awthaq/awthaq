---
ID: "PV-240"
Title: "Rate-limit key strategies \"principal\" and \"ip\" are registry metadata only: nothing derives a bucket key from them"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/RateLimits.ts:59"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-240 — Rate-limit key strategies "principal" and "ip" are registry metadata only: nothing derives a bucket key from them

`LOW` · `correctness` · `core` · found while wiring `features/features/04-cross-cutting/14-rate-limiting.feature` (P20a, REQ-EA-290)

Status: **resolved**

## Summary

BEH-EA-108 says a rule's bucket key is derived from a built-in strategy (`"principal"` — the caller's `CurrentPrincipal`; `"ip"` — the request's network origin) or from an explicit function. `RateLimits.RuleInput.key` accepts those two names, but nothing in `packages/*/src` ever reads the value: `RateLimitsRegistry.register` stores it, `registered` returns it, and every plugin that actually enforces a rule (`@awthaq/password`'s `PasswordRateLimits`) computes its own key and calls `RateLimits.enforce`. A plugin author who declares `key: "principal"` therefore gets a registry entry and no enforcement, and the BDD scenario "A rate-limit rule keys its bucket using a built-in strategy" (REQ-EA-290) has nothing to observe, so it is `@skip` with this issue.

## Evidence

- `packages/core/src/RateLimits.ts` — `RateLimitKey = "principal" | "ip" | ((input: unknown) => string)`; only `register`/`registered` touch it.
- `packages/password/src/PasswordRateLimits.ts` — rules carry their own `keyOf`, fed by `ClientAddress`/the payload, never by a strategy name.

## Recommended fix

Either implement the resolvers (a `RateLimits.keyFor(rule, request)` that reads `CurrentPrincipal` / `ClientAddress`, used by `RateLimits.enforce`), or narrow BEH-EA-108 and the type to "a rule's key is a function" and drop the strategy names. Then wire REQ-EA-290 (or delete it).

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P20a):** Left open: PV-240 (principal/ip key strategies are registry metadata only) needs the RateLimits key derivation to be designed against ClientAddress and CurrentPrincipal; not a small fix.

**Resolved (2026-09-29):** packages/core/src/RateLimits.ts: RateLimits.bucketKey(rule, input?) resolves the rule's key strategy against the request (principal from CurrentPrincipal, ip from the ClientAddress port over the ambient HttpServerRequest with an explicit unknown bucket, or the function) and namespaces it per group.endpoint; RateLimits.enforceRule derives it and consumes through enforce (dimension from the strategy, never the key). Overloads keep each strategy's requirements precise (no casts). Red first: packages/core/test/RateLimitKeys.test.ts and REQ-EA-290 un-skipped in 14-rate-limiting.feature with new steps. BEH-EA-108 has an as-shipped paragraph. Plugins that enforce through their own keys (password) are unchanged and still register the same rules. Gates: typecheck, core suite (543), features 04-cross-cutting/14, spec:verify:strict, knip.
