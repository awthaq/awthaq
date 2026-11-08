# @awthaq/server

HTTP stratum (5). Middleware implementations, core handlers, AuthHttp — the mechanism that registers a composed HttpApi with a router.

**Shipped**: `Authentication` / `OptionalAuthentication` (cookie first, bearer second, per-request session memoization, rotated-secret delivery — BEH-EA-065–072), `Csrf` (double-submit cookie — BEH-EA-073–080), `Session` (the core `session` group handlers), `Account` (the core account group, including `deleteUser`'s transactional erasure cascade) `AuthHttp` (`routes`/`docs`, the error-to-status mapping — BEH-EA-081–088) and `AuthHost` (the servable layer derived from `Auth.make` — BEH-EA-340/341, ADR-EA-044).

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

## Logging hazard: the rotated session token

The server delivers a rotated bearer token in the `set-auth-token` response header (a long-lived secret, `Cache-Control: no-store`). Effect's default redacted header names do not include it, so provide `AuthHttp.layerRedactedHeaders` (which adds `set-auth-token` and `x-jwt-token` to Effect's defaults) wherever requests or responses are logged or traced, and make sure any proxy preserves the header. A host-supplied logger that does not read `Headers.CurrentRedactedNames` must redact those names itself.

## Serving a composition (`AuthHost`)

`AuthHost.layer(auth, options)` turns an `Auth.make` result into the layer you serve. It derives everything that is a function of the plugin tuple, so you never write it; you pass what only you can choose and provide your ports.

| `AuthHost` derives (composition-owned) | You provide (host-owned) |
|---|---|
| routes for `api` / `publicApi` / `adminApi` (`tier`), core's `session`/`account` handlers, OpenAPI/Scalar at `openapiPath`/`docsPath` | `persistence` (required): `{ records: "memory" }`, or `{ records: "sql", client, migrations, options? }` |
| `auth.layer`, each plugin's `records` bundle for the mode, each plugin's declared `hookPoints` | `csrf` (required): `Csrf.layerConfig` or a `CsrfConfig` layer |
| core's services over `Persistence.memory` / `Persistence.sql(options)`: `Users`, `Accounts`, `Sessions`, `Verification`, `AuditLog`, `AuthEvents`, `AuditChain`, erasure, export | `principalResolver` (default `Credentials.PrincipalResolverLive`) |
| the registries: `Hooks.HooksLive`, `RateLimits.layer`, `Slots.layer`, `Credentials.CredentialResolversLive` | `services`: plugin configuration, extra-group handlers, adapters, gates |
| the host middleware the groups declare (`AuthHttp.middlewareFor`) and the resolver | `taps`: your hook taps, built over the composition's own points |
| `auth.userFieldsLayer` | `decorate`: wrap a composition-owned service in place (metrics, a fault) |
| SQL: core's migrations then `auth.migrations`, with the ledger-drift refusal | ports, left in `RIn`: `PasswordHasher`, `Mailer`, `RateLimiter`, `ClientAddress`, `Encryption`, `SecureRandom`/`Digest`/`Mac`, `HttpClient`, ... |
| the request context's populator (`Api.RequestContext`, among the derived middleware) and `BodyLimit.layer` (dial `bodyLimit`, default `true`) | platform, left in `RIn`: `HttpRouter`, `HttpPlatform`, `Etag.Generator`, `FileSystem`, `Path` (`HttpServer.layerServices` + `HttpRouter.layer`, or `HttpRouter.serve`/`toWebHandler`) |

```ts
const auth = Auth.make([Password.Password, Organization.Organization])

const App = AuthHost.layer(auth, {
  persistence: { records: "sql", client: SqlLive, migrations: "apply" },
  csrf: Csrf.layerConfig,
}).pipe(
  Layer.provide(Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerConsole, RateLimiterLive, ClientAddress.layerDirect, EncryptionLive, FetchHttpClient.layer)),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(HttpRouter.layer),
)
```

**`RIn` is your to-do list.** Whatever the compiler still lists in the layer's requirements is a port, an adapter or a platform service only you can choose; `Layer.launch` does not compile until it is empty. Nothing composition-owned is ever left there.

**Migrations (`records: "sql"`).** `migrations` is required. `"apply"` runs core's pending migrations, then the composition's (user-field columns included), when the layer is built and before anything is built over the client; with nothing pending it calls no migrator. `"verify"` applies nothing and refuses to build (`Migrations/Pending`, naming each pending migration): use it when `awthaq migration apply` is your deploy step, and for a CLI `app`, which must never migrate behind `migration apply --yes`. Either mode refuses a ledger that disagrees with the linker (`Migrations/LedgerDrift`, the CLI's check). Two replicas booting with `"apply"` are serialized by the migrator's ledger lock.

**Beside it, not inside it.** Host jobs and edge middleware stay in your code, merged next to the layer: `Retention.layerScheduled`, `SecuritySignals.layer`, `SecurityHeaders.layer()`, `AuthHttp.cors(...)`, `AuthHttp.layerRedactedHeaders`, the SQL rate limiter's own store and ledger. A worker or a CLI command that needs the services without serving builds the same layer with `HttpRouter.layer` provided.

**`services` versus `decorate`.** A `services` layer sits closest to the plugins and is merged into the output, so `yield*` returns the instance the plugins used. For a key the composition also provides, the plugins see yours but the output holds the composition's; `decorate` (built over the composition's service, shadowing it above) replaces one for everyone. `bodyLimit: false` (or `BodyLimit.config({ maxBytes })` in `services`) when a route of yours on the same router takes larger bodies.

## Request context (ADR-EA-047)

Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware, and `AuthHttp.middlewareFor` (so `AuthHost.layer`) derives its implementation, `RequestContext.RequestContextLive`, like the other host middleware. It captures the request once: a correlation id (a sane `x-request-id`, else the `traceparent` trace id, else a fresh uuidv7), the client address (what the `ClientAddress` port resolves; the populator is that port's one consumer, so the port is required) and the user agent (capped at 512 characters). It provides them as `Api.AuthRequestContext` and annotates the request's logs with the correlation id. Sessions, rate limits, events and audit rows all read this one value.

- **Required by the type.** A handler or authentication middleware that reads the context, served without its populator, does not compile: the middleware is an unmet requirement, a forgotten declaration leaves an unsatisfiable `HttpRouter.Request<"Requires", AuthRequestContext>`, and the four authentication middlewares `require` the context, so a group of yours that declares `Api.Authentication` (or `MachineAuthentication`, `AdminAuthentication`, `OptionalAuthentication`) must declare `.middleware(Api.RequestContext)` after it. A hand-wired composition provides `RequestContext.RequestContextLive` (it needs `ClientAddress` and `SecureRandom`).
- **Host routes.** A route of yours outside awthaq's contracts that calls a plugin operation provides the facts itself: `Effect.provideService(Api.AuthRequestContext, yield* RequestContext.capture(request))`, or declare `Api.RequestContext` on its group. In-process work (a job, a CLI command) states `Api.AuthRequestContext.noRequest`. Never provide a fixed `AuthRequestContext` as a layer: it would stamp one value on every request.
- **Web handlers.** `HttpRouter.toWebHandler` (Next.js, Workers, Bun) reports no socket peer, so under `ClientAddress.layerDirect` every client resolves to no address and shares the `ip:unknown` rate-limit bucket. Behind a proxy, provide `ClientAddress.layerTrustedProxy(...)`.

## Session delivery

An endpoint that changes the caller's session declares it on the contract with a `SessionLifecycle` marker (`Mints`, `Rotates`, `Ends`, `Swaps`, `Refreshes`; ADR-EA-045). `AuthHttp.middlewareFor` (and so `AuthHost.layer`) derives the markers' server half like the other host middleware; a hand-wired composition provides `AuthHttp.sessionLifecycle`. The marker validates `X-Awthaq-Token-Delivery` before the handler runs, makes the response `Cache-Control: no-store`, and provides the grant `SessionDelivery` requires: `respond(mint)` delivers a minted session as a cookie or, for `bearer`, as the body's `token` and the `set-auth-token` header; `end` expires the session and answers `x-awthaq-session-ended`; `redirect`, `deliverBearer`, `deliverExchanged`, `swapIn`, `swapOut` and `decline` cover the rest. A successful response that settles nothing is a defect. `AuthHttp.cors` exposes both response headers.

## Deployment checklist

- **HSTS at the edge.** Serve every auth route over HTTPS only and send `Strict-Transport-Security` from the edge (CDN, load balancer or reverse proxy) — the session cookie is `Secure`/`__Host-` and cannot work over plain HTTP. If your Node process *is* the edge, merge `SecurityHeaders.layer()` into your router layer instead.
- **`SecurityHeaders.layer(options?)`** is an opt-in global `HttpRouter` middleware (PDR-004) that adds `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` to every response. Each header can be overridden with a string or omitted with `false`, and it never overrides a header a handler already set. The OAuth authorize/callback responses always send `Referrer-Policy: no-referrer` themselves (their URLs carry the provider's `code`/`state`).
- **Do not double-send.** If the edge already sets one of these headers, pass `false` for it so the response carries a single value.
