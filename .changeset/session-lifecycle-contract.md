---
"@awthaq/api": minor
---

`SessionLifecycle.Mints`/`Rotates`/`Ends`/`Swaps`/`Refreshes` declare, on the contract, what an endpoint's successful response does to the caller's session (ADR-EA-045, BEH-EA-343). They are `HttpApiMiddleware` markers: typed (each provides a grant, `MintGrant`/`EndGrant`/`SwapGrant`, that `@awthaq/server`'s `SessionDelivery` requires) and reflectable (`SessionLifecycle.inventory(api)` lists the declared endpoints by `operationId`, and `SessionLifecycle.openApi` documents their headers). `Mints`, `Rotates` and `Swaps` declare `InvalidTokenDelivery`. `Api.SESSION_ENDED_HEADER` (`x-awthaq-session-ended`) names the header an ended session answers with.

Migration: none (additive).
