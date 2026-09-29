# HTTP Serving and Error Mapping

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-11 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a cross-reference to ADR-EA-013 (error taxonomy and HTTP status mapping) (CCR-EA-002) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §14 and `archive/design/usage-examples-v4.md` §3 — not code that has shipped.

## BEH-EA-081: A plugin's handlers are built with `HttpApiBuilder.group` against its own contract

> **See:** [ADR-EA-003](../decisions/003-httpapi-as-contract.md)

```ts
static readonly layer = AuthPlugin.layer(Password, {
  make: /* … */,
  handlers: PasswordHandlers   // HttpApiBuilder.group(PasswordContract, "password", …)
})
```

```text
REQUIREMENT: A plugin's handler Layer MUST be built with
             `HttpApiBuilder.group` against that same plugin's own
             `contract`, naming the group id the plugin itself declared —
             never against a contract or group id belonging to another
             plugin or to core.
```

`archive/design/plugins-as-layers.md` §2.1 shows `PasswordHandlers` built exactly this way, and BEH-EA-004's namespace constraint is what guarantees the group id a plugin's handlers target is always one the plugin itself is entitled to own. A plugin author writing handlers is therefore always writing against a contract they authored, never reaching into another package's group definition to attach behavior to it.

## BEH-EA-082: A group's service key derives from its group id, so plugin handlers satisfy the merged `AuthApi`

```ts
type GroupService = HttpApiGroup.ToService<"auth", "password">
```

```text
REQUIREMENT: The service `HttpApiBuilder.layer(auth.api)` requires for a
             given group MUST be derivable purely from that group's id, so
             that a handler Layer built against one plugin's own contract
             in isolation already satisfies the requirement the fully
             merged `AuthApi` demands for that same group.
```

`archive/PRD.md` §14 states this directly: "group service keys derive from the group id, so they satisfy the merged `AuthApi`." This is what makes it possible for `auth.layer` (BEH-EA-009) to fold each plugin's independently-authored `handlers` Layer into one composed Layer without any handler needing to know, at authorship time, which other plugins will eventually be installed alongside it.

## BEH-EA-083: `AuthHttp.routes(auth.api)` registers the composed API with the router

```ts
const Routes = AuthHttp.routes(AuthApi).pipe(Layer.provide(AuthLive))
Layer.launch(HttpRouter.serve(Routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))))
```

```text
REQUIREMENT: `AuthHttp.routes` MUST accept the `auth.api` value produced by
             `Auth.make` (or `Auth.api` composing it with application
             groups) and MUST require, as its own `RIn`, exactly the
             services `auth.layer` provides — no additional wiring step.
```

`archive/design/usage-examples-v4.md` §1.1 and §3.1 both show `AuthHttp.routes(AuthApi)` composed with an application's own `HttpApiBuilder.layer(AppApi)` under one `Layer.mergeAll`, then provided `AuthLive` as a single dependency — registering awthaq's routes alongside an application's own is designed to require no more ceremony than merging one more Layer into the same list.

## BEH-EA-084: `AuthHttp.docs` serves generated OpenAPI/Scalar documentation from the same contract

```ts
GET  /auth/openapi.json
GET  /auth/docs
```

```text
REQUIREMENT: `AuthHttp.docs(auth.api)` MUST derive its served OpenAPI
             document and documentation UI entirely from the same `auth.api`
             value the router serves, so that the documentation can never
             diverge from the routes actually registered.
```

`archive/design/usage-examples-v4.md` §1.1 lists `GET /auth/openapi.json` and `GET /auth/docs` among the routes a default installation exposes with no additional configuration. Because `auth.api` is the one value both `AuthHttp.routes` and `AuthHttp.docs` consume, the documentation is designed to be a projection of the same contract the server actually enforces, not a separately maintained description of it.

## BEH-EA-085: `HttpRouter.serve` and `HttpRouter.toWebHandler` are the two designed serving paths for different hosts

```ts
// Effect-native platform server
Layer.launch(HttpRouter.serve(Routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))))

// Next.js / Hono / any Request → Response host
const { handler } = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(HttpServer.layerServices)))
export { handler as GET, handler as POST }
```

```text
REQUIREMENT: The same composed `Routes` Layer MUST be servable through
             `HttpRouter.serve` (for an Effect-managed platform server) and,
             without modification, through `HttpRouter.toWebHandler` (for
             any host that hands the application a `Request` and expects a
             `Response`), so that hosting choice is a serving-layer decision
             only.
```

`archive/design/usage-examples-v4.md` §3.1–§3.3 demonstrate both paths against the identical `Routes` value: a standalone Node server via `HttpRouter.serve`, and a Next.js route handler or Hono catch-all route via `HttpRouter.toWebHandler` — the plugin composition, the contract, and the handlers are unaffected by which of the two a deployment chooses.

Both serving paths are **bounded by default** (NHS-004). Effect's server reads request bodies with no cap unless `HttpIncomingMessage.MaxBodySize` is set, so an unauthenticated caller could otherwise make the process buffer an arbitrarily large body before any handler, CSRF check or rate limit ran. `@awthaq/server`'s `BodyLimit.layer` is a global `HttpRouter` middleware, merged into the same layer list as `AuthHttp.routes(...)`, that provides `MaxBodySize` (default 256 KiB; `BodyLimit.config({ maxBytes })` overrides it per deployment) and answers `413` `PayloadTooLarge` (`{ "_tag": "PayloadTooLarge", "message": ... }`) to any request whose declared `content-length` exceeds the cap, before the handler runs. On a Node server the body reader also cuts off a chunked body with no `content-length` at the cap, by dropping the connection (no 413 can be written to a destroyed socket). On `HttpRouter.toWebHandler` the runtime does not consult `MaxBodySize`, so the `content-length` check is the bound there; a chunked body without `content-length` is left to the host's own limits.

## BEH-EA-086: Error responses are enumeration-safe uniformly across the HTTP surface

```text
REQUIREMENT: Every endpoint whose failure could disclose whether a
             specific account, email, or token exists MUST answer with the
             same status and body for the "target does not exist" case and
             the "target exists but the request was otherwise invalid"
             case.
```

This is BEH-EA-027 and BEH-EA-064 restated as a property of the HTTP surface taken as a whole, per `archive/PRD.md` §18's "uniform enumeration-safe errors": the requirement applies not only to sign-in (`InvalidCredentials`) and password reset (`requestReset` always `202`), but to every endpoint the composed `auth.api` exposes, including ones contributed by third-party plugins — a plugin author is expected to apply the same discipline to their own account- or token-existence-sensitive endpoints.

TMS-005: `password.signUp` is the one recorded exception. By default (`signUpEnumeration: "reveal"`) it answers `409 EmailAlreadyExists` for a registered address, with the `signUp`/`signUpByIp` rate limits as compensating controls; `"conceal"` closes it (`202`, no session, mail to the address's owner). See [ADR-EA-026](../decisions/026-signup-enumeration-posture.md).

## BEH-EA-087: `ManagedRuntime` serves imperative, non-Effect-native code paths against the same Layer

```ts
export const runtime = ManagedRuntime.make(AuthLive)

app.get("/me", async (c) => {
  const view = await runtime.runPromise(/* … */)
  return view ? c.json(view) : c.body(null, 401)
})
```

```text
REQUIREMENT: `ManagedRuntime.make(AuthLive)` MUST expose a `runPromise`
             entry point capable of running any Effect program built
             against `AuthLive`'s provided services, so that a host
             framework's own imperative route handler (one not built on
             `HttpRouter`) can still call into awthaq's domain
             services directly.
```

`archive/design/usage-examples-v4.md` §3.4 documents this as the escape hatch for hosts that are not themselves Effect-native — a Hono handler resolving the session cookie and rendering JSON without ever touching `HttpApiBuilder` at all, built on the same `AuthLive` Layer every other serving path in this file shares, so the domain logic is not duplicated for imperative callers.

## BEH-EA-088: Every contract error's HTTP status is derived from its `httpApiStatus` annotation, uniformly

> **See:** [ADR-EA-013](../decisions/013-error-taxonomy-http-mapping.md)

```text
REQUIREMENT: The HTTP status code a client observes for any contract error
             MUST be read from that error's own `Schema.TaggedError`
             `httpApiStatus` annotation (BEH-EA-027), with no separate,
             out-of-band status-mapping table maintained anywhere in the
             HTTP stratum.
```

Because every error in the contract stratum already carries its status as an annotation on its own schema (BEH-EA-027), the HTTP layer's job is reduced to reading that annotation off whichever tagged error a handler fails with — there is deliberately no second mapping (a `switch` over error tags to status codes, maintained separately from the error definitions) that could drift out of sync with the errors it maps, which is exactly the kind of duplicated source of truth `archive/PRD.md` §5 (Design principle 5) rules out project-wide.

_Previous: [BEH-EA-080](10-csrf.md#beh-ea-080-the-csrf-cookie-name-and-header-name-are-fixed-not-per-plugin-configurable)_
_Next: [BEH-EA-089](12-hooks.md#beh-ea-089-a-hook-point-is-declared-as-a-service-carrying-its-own-kind)_
