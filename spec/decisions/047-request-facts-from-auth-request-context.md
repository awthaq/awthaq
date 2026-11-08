# ADR-EA-047: Request Facts Are Read From `AuthRequestContext`

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-047 |
> | Revision | 1.0 |
> | Effective Date | 2026-11-08 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-08): Initial release (architecture plan 26) |

---

## Context

Two facts about the request a piece of work answers matter to awthaq: the client address (forensics, the device list, per-source rate limits, the credential-stuffing signal) and the user agent (the device list, forensics). Until this decision they travelled two ways. A global router middleware, `RequestContext.layer`, filled `AuthRequestContext` (a `Context.Reference` defaulting to "nothing") for event envelopes and audit rows; it was opt-in (architecture plan 01, decision 7), and `AuthHttp.coreHandlers` warned at build time when it was missing. Separately, ten plugin classes resolved the address and read the user agent in their own handlers and threaded both, as optional `ip`/`userAgent` fields on about thirty interface members, into `SignIn`, `SignUp`, `Sessions.issue` and the `ip` rate-limit strategy. Each consumer read one of the two: sessions and rate limits the explicit fields, events the context. The warning said sessions would record nothing without the middleware, which was false for sessions and true for events. Because `ip` was optional everywhere, a caller that forgot it compiled and landed in the one shared `ip:unknown` bucket. Admin impersonation recorded nothing in any composition, and the audit row's user agent was uncapped while the session row's was capped.

## Decision

1. **One source.** `AuthRequestContext` lives in `@awthaq/api` beside `CurrentPrincipal`. It is a required `Context.Service` with no default, whose value is `Request { correlationId, ip, userAgent }` or `NoRequest`. Request facts are read from it and nowhere else; no public interface takes an address or a user agent.
2. **One populator, required by the type.** The endpoint middleware `Api.RequestContext` (`provides: AuthRequestContext`) is declared last (outermost) on every awthaq group; `@awthaq/server`'s `RequestContextLive` implements it (the only reader of `ClientAddress`, `x-request-id`/`traceparent` and `User-Agent`), and `AuthHttp.middlewareFor` (so `AuthHost`) derives it. Serving a group without it does not compile: the middleware is an unmet requirement, a forgotten declaration leaves an unsatisfiable `HttpRouter.Request<"Requires", AuthRequestContext>`, and the four authentication middlewares `require` the context, so declaring it inside them is an error. `ClientAddress` is a required dependency of the populator.
3. **Required readers.** `Sessions.issue`, `SignIn` (`clear`, `resume`, `issue`, `complete`, `failed`), `SignUp.createSignedIn`, the `ip` rate-limit strategy (through the budget's typed handle, `RateLimits.RequiresOf`) and every plugin operation that mints a session, spends an ip-keyed rule or announces a failed sign-in name `AuthRequestContext` in their requirements. Credential claims receive it (`Credentials.httpScope(request, context)`).
4. **Optional readers.** Event envelopes, audit rows and observe taps deferred to commit read it when present; publishing from a job needs nothing. qadi's Path B extractor, whose external interface cannot carry a requirement, reads it when present and otherwise captures it with the same function (`RequestContext.capture`).
5. **Explicit absence.** In-process work states `AuthRequestContext.noRequest`. Under it a session records no address or user agent, the `ip` strategy does not apply (the identity and principal rules still do), and events carry no request facts. A request whose address cannot be resolved keys the shared `ip:unknown` bucket.
6. **One cap, one publisher.** The user agent is capped at 512 characters by the only constructor of the branded `UserAgentHeader`, so sessions, events, audit rows and webhooks agree. `auth.user.signInFailed` is published only by `SignIn.failed`, which takes `clientIp` from the context.

## Consequences

**Positive.** A composition that serves awthaq's routes cannot forget the request context; the warning and its router registry are gone. Plugins know nothing about addresses, proxies or headers; the topology choice (`ClientAddress`) has one consumer. A forgotten address is a compile error, not a shared bucket. Impersonation sessions record the administrator's facts. The audit trail gets the same capped user agent as the session row. `TestAuth` serves with the same middleware as production.

**Negative.** Every awthaq group carries one more middleware declaration, and a host's own group that uses an authentication middleware must declare `Api.RequestContext` after it. In-process callers of plugin operations (tests, jobs, a host route outside awthaq's contracts) must provide the context explicitly; a host route does so with `RequestContext.capture(request)`. Providing a fixed `AuthRequestContext` as a layer would silence the compiler and stamp one value on every request; it is documented as wrong and forbidden in library source by a seam test (`RequestContextSeams.test.ts`). A group that reads nothing still compiles without the middleware; `awthaq doctor` warns about it.

**Trade-off accepted.** One required per-request value threaded by the type system, in exchange for the removal of the opt-in path, the explicit path and their disagreement.

## Alternatives considered

- **Keep the middleware opt-in, keep the explicit fields, keep the warning** (architecture plan 01, decision 7). Rejected: two sources that disagree, a warning about the wrong consumer, and an optional `ip` the compiler cannot enforce.
- **A global router middleware that `provides` the context.** It also makes handler requirements visible, but only `Layer.provide(app, middleware)` satisfies the `Request<"Requires">` marker, so the established idiom of merging edge middleware beside the routes would silently stop satisfying it, and it has no place in the declared contract that `middlewareFor`, `doctor` and contract tests can read.
- **Core installs a route-scoped provider inside `AuthPlugin.layer`.** No host step at all, but it couples core's plugin substrate to the HTTP router and to `ClientAddress`, and leaves host-declared groups and core's own groups to a second mechanism.
- **Keep `AuthRequestContext` a `Context.Reference` and check at run time.** A default that means "nothing" is exactly what made the middleware forgettable.
- **Make `ip` required on the plugin interfaces instead.** Enforces presence, but keeps two sources, ten copies of the resolution and the plugins' knowledge of HTTP.

## Related

ADR-EA-010 (plugins require ports; plugins no longer require `ClientAddress`), ADR-EA-012 (the context is neither a slot nor a registry), ADR-EA-032 (the correlation id field), ADR-EA-037 (deferred observe taps see the captured context), ADR-EA-038 (`SignIn.issue` mints from a clearance; it now reads the context), ADR-EA-042 (credential resolution; claims receive the context), ADR-EA-045 (the session-lifecycle markers sit inside the request context). Supersedes architecture plan 01's decision 7. BEH-EA-054, BEH-EA-065, BEH-EA-101, BEH-EA-108, BEH-EA-197, BEH-EA-209, BEH-EA-322.
