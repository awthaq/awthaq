# ADR-EA-045: An Endpoint's Effect on the Caller's Session Is Declared on the HttpApi Contract

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-045 |
> | Revision | 1.1 |
> | Effective Date | 2026-11-08 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-08): Initial release (architecture plan 21) <br> 1.1 (2026-11-09): `SessionDelivery.redirect` is replaced by `land`, which owns the PV-016 landing choice for every browser return trip (architecture plan 33) |

---

## Context

"This endpoint mints (or rotates, ends, swaps) the caller's session" is a fact about the contract, but only handler bodies knew it, and each of four readers re-derived it:

- The server: `SessionDelivery.respond(request, mint)` at seven call sites, `mode` at one, `deliver` at one, and four handlers that wrote the session cookie without it (the OAuth callback and native exchange, the SAML ACS, admin impersonation). Eight handlers ended a session with a bare cookie expiry. The guard was a regex test counting `SessionDelivery.mode(` and `SessionDelivery.deliver(` calls; it could not see a hand-rolled `render` + `setCookie`.
- The bearer client: `captureSessionToken` read `Reflect.get(body, "token")`, and every caller had to remember to wrap every minting call. A bearer `changePassword` returned the new token only in the body and no `set-auth-token`, so a client built as documented kept the superseded token; presenting it again is refresh-token reuse (RRS-003), and `Sessions.verify` revoked the whole family. A bearer sign-out left the dead token in the store, and a sign-out whose verify had rotated carried a `set-auth-token` for the session it had just revoked.
- React: a mutation that changed the session had to pass `reactivityKeys: [SESSION_KEY]` at every call site, or `sessionAtom` and the `Can` gates went stale.
- The OpenAPI document did not state the lifecycle, `no-store`, or either header.

## Decision

**1. Five `HttpApiMiddleware` markers in `@awthaq/api`'s `SessionLifecycle`.** `Mints` (sign-up, sign-in, a second factor, a federated callback, a device or native exchange), `Rotates` (the caller's credential is replaced: `changePassword`), `Ends` (the caller's own session ends), `Swaps` (impersonation, APS-006) and `Refreshes` (the session's view or subject changes, the credential does not). An endpoint declares at most one: `.middleware(SessionLifecycle.Mints)`. `SessionLifecycle.inventory(api)` lists the declared endpoints by `operationId` and throws on a double declaration, which `Auth.make` runs, so a contract mistake fails at composition like a duplicate route. `Mints`, `Rotates` and `Swaps` declare `InvalidTokenDelivery`; no endpoint lists it by hand.

**2. Grants and the type-level gate.** `Mints`/`Rotates` provide `MintGrant`, `Ends` `EndGrant`, `Swaps` `SwapGrant`. Every function of `@awthaq/server`'s `SessionDelivery` requires one: `respond(mint)`, `deliverBearer`, `deliverExchanged` and `land` need `MintGrant`; `end` needs `EndGrant`; `swapIn`/`swapOut` need `SwapGrant`; `decline(grant)` needs the grant it names. A handler of an endpoint that did not declare the right kind leaves `HttpRouter.Request<"Requires", Grant>` in the group layer's requirements, so the layer cannot be served (a compile error, pinned by `SessionLifecycle.types.test.ts` and two BDD type gates). `land(location, issued, { bounce })` lands a browser return trip (the OAuth callback, the SAML ACS): the same-site interstitial while the session cookie is `SameSite=Strict` and `bounce` holds, a `302` otherwise, declining when nothing was minted (BEH-EA-122, BEH-EA-350).

**3. The marker's server half.** It resolves `X-Awthaq-Token-Delivery` before the handler runs (an unknown value is a 400 that mints nothing; `Swaps` refuses `bearer`; `Ends` reads no header), provides the grant, marks the response `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` (500) when a successful response neither delivered nor declined. A typed handler error is not a defect. `AuthHttp.middlewareFor` derives the five like the other host middleware; `AuthHttp.sessionLifecycle` is the layer for a hand-wired composition.

**4. Headers are the client signal.** Every bearer delivery names the token in `set-auth-token` as well as the body's `token`. `end` expires the cookie, answers `x-awthaq-session-ended: 1`, and removes a `set-auth-token` the verify-time rotation registered (pre-response handlers run in registration order; the handler's runs later and wins). `AuthHttp.cors` exposes both headers. `bearerTransformClient` stores every `set-auth-token` and clears on `x-awthaq-session-ended` (which wins); `captureSessionToken` is gone.

**5. React invalidates on its own.** `makeReactClient` always installs `ReactClient.sessionInvalidation`, the client half of the five markers: after a 2xx response of a declared endpoint it invalidates `SESSION_KEY` on the registry's own `Reactivity` (the atom runtime builds `Reactivity.layer` into the registry's memo map, so the layer built beside the transport is that instance).

**6. OpenAPI.** `Auth.make` annotates the composed api (and each tier) with `SessionLifecycle.openApi(inventory)`, an `OpenApi.Transform` that adds `x-awthaq-session` to declared operations and documents `no-store` on their responses, `set-auth-token` on a mint's or rotation's 2xx and `x-awthaq-session-ended` on an end's 2xx. An application that sets its own api-level `OpenApi.Transform` replaces this one and composes it by calling `SessionLifecycle.openApi(SessionLifecycle.inventory(api))` inside its own.

**7. Core stops writing the session cookie onto responses.** `@awthaq/core`'s `SessionCookie` keeps the configuration and the pure renderers (`render`, `renderAt`, `baseOptions`); `set`, `expire` and `expireImpersonation` moved into `@awthaq/server`, behind `SessionDelivery`.

## Alternatives considered

- **(a) A `Context` annotation read the way qadi reads `RequiredPermission` (ADR-EA-015).** Rejected: `HttpApiEndpoint.annotations` is `Context.Context<never>`, type-erased, so it could drive the client and the document but no compile-time gate.
- **(b) One marker with the kind in an annotation.** Rejected: an `Ends` handler could then call `respond`; one grant per family of kinds is what makes the crossed call a compile error.
- **(c) The client reads the declaration and inspects bodies.** Rejected: conditional outcomes (`revoke` of another device, `forceStop` of another episode, an OAuth link) are known only to the server, and a non-Effect client reads headers anyway.
- **(d) `requiredForClient: true` on the markers.** Rejected: every cookie client and the CLI would need a no-op layer for no benefit.
- **(e) Keep the regex test and extend its patterns.** Rejected: a text search cannot see a hand-rolled `render` + `setCookie`.

## Consequences

**Positive**: one declaration per session-changing endpoint, visible in its type; the server, both clients and the document read it. A bearer client stays signed in through `changePassword` and forgets an ended session with no code of its own. A React app refetches the session after any declared mutation. The delivery header is validated structurally before anything is minted.

**Negative**: a declared endpoint whose handler has an untested success path that forgets `SessionDelivery` answers 500 in production (fail closed, by choice: the defect names the endpoint and the kind). A hand-wired composition must add `AuthHttp.sessionLifecycle`. A plugin's handler file sometimes needs a type alias naming a marker for declaration emit (TS2883).

**Trade-off accepted**: `set-auth-token` now appears on every bearer mint, not only on a rotation; `AuthHttp.layerRedactedHeaders` already redacts it. The IdP-initiated SAML SLO, password reset and email-change confirmation stay undeclared: they act on sessions the request does not present.

## Related

[ADR-EA-003](003-httpapi-as-contract.md) (the contract carries the lifecycle), [ADR-EA-015](015-qadi-bridge-path-selection.md) (the annotation mechanism, alternative a), [ADR-EA-026](026-signup-enumeration-posture.md) (the concealed sign-up declines), [ADR-EA-042](042-credential-resolution-module.md) (rotation delivery), [BEH-EA-343](../behaviors/04-contract-stratum.md#beh-ea-343-an-endpoint-declares-what-it-does-to-the-callers-session-on-the-contract), [BEH-EA-066](../behaviors/09-authentication-middleware.md), [BEH-EA-175](../behaviors/22-client-effect.md), [BEH-EA-178](../behaviors/23-react.md).
