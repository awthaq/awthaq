# @awthaq/server

HTTP stratum (5): the implementations of the contract's middleware and the mechanism that registers a composed `HttpApi` with a router.

**Shipped**: `Authentication` / `OptionalAuthentication` (cookie first, bearer second, per-request session memoization, rotated-secret delivery — BEH-EA-065–072), `Csrf` (double-submit cookie — BEH-EA-073–080), `Session` (the core `session` group handlers), `Account` (the core account group, including `deleteUser`'s transactional erasure cascade) and `AuthHttp` (`routes`/`docs`, the error-to-status mapping — BEH-EA-081–088).

See [`spec/behaviors/09-authentication-middleware.md`](../../spec/behaviors/09-authentication-middleware.md), [`10-csrf.md`](../../spec/behaviors/10-csrf.md) and [`11-http-error-mapping.md`](../../spec/behaviors/11-http-error-mapping.md).
