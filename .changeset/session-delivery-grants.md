---
"@awthaq/server": minor
---

`@awthaq/server` implements the server half of the `SessionLifecycle` markers (ADR-EA-045, BEH-EA-343): `SessionLifecycle.MintsLive`/`RotatesLive`/`EndsLive`/`SwapsLive`/`RefreshesLive` (all five as `SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`), derived by `AuthHttp.middlewareFor` like the other host middleware. A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery` gains `respond(mint)`, `deliverBearer`, `deliverExchanged`, `redirect`, `end`, `swapIn`, `swapOut` and `decline`, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token`; `end` answers `x-awthaq-session-ended` (exposed by `AuthHttp.cors`).

Migration: none yet (additive).
