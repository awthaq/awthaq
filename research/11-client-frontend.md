# Client & Frontend — Research
Scope: Q39–Q40 (client generation, framework adapters) and Q82–Q87 (client surface, React package, Next.js, adapter contract, error typing/i18n, SPA/BFF topologies). Researched against the ecosystem as of 2026-09-12. Versions verified via npm (`effect` 3.22.2 stable / v4 beta, `better-auth` 1.7.4, `@tanstack/react-query` 5.102.8, `@trpc/tanstack-react-query` 11.18.0, `hono` 4.13.7, `openapi-typescript` 7.13.0, `@hey-api/openapi-ts` 0.99.0, `orval` 8.31.0, `@tanstack/react-start` 1.168.52).

## TL;DR

- Effect `HttpApiClient` already gives effect-auth nearly the whole typed client for free: methods derived per group/endpoint, schema-encoded requests, schema-decoded successes and typed errors, per-endpoint/per-group client builders, a type-safe `urlBuilder`, and client-side middleware requirements expressed in the type via `requiredForClient` + `HttpApiMiddleware.layerClient` ([v4 HttpApiClient](https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiClient), [v4 HttpApiMiddleware](https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiMiddleware)). What we hand-write is the session store, CSRF header injection, cookie/bearer policy, and error-message catalogs — not endpoint plumbing.
- In Effect v4 HttpApi lives under `effect/unstable/httpapi` and is marked unstable; the July 2026 beta "hardening pass" fixed client error decoding, type-level performance, duplicate handler/OpenAPI rejection, and made `HttpApi` composition immutable ([v4 beta recap](https://www.effect.website/blog/effect-v4beta-july-recap)). Version isolation is mandatory for anything we build on it.
- `effect-atom` (`@effect-atom/atom-react`, MIT, by Effect core member Tim Smart) is the natural substrate for `@effect-auth/react`: `Atom.runtime(layer)` hooks an Effect Layer into React, `AtomHttpApi` turns an `HttpApi` directly into reactive `query`/`mutation` atoms with `reactivityKeys` invalidation and SSR hydration support ([effect-atom](https://github.com/tim-smart/effect-atom), [AtomHttpApi](https://raw.githubusercontent.com/tim-smart/effect-atom/main/docs/atom/AtomHttpApi.ts.md)).
- better-auth's client is the UX benchmark: one `createAuthClient` per framework, plugin-extensible methods, `useSession` returning `{ data, isPending, error, refetch }` on nanostores, `hydrateSession(initialSession)` to kill SSR loading flashes, `$ERROR_CODES` for i18n, and `$Infer.Session` for type flow ([client docs](https://better-auth.com/docs/concepts/client)).
- Auth.js is now maintained by the Better Auth team (announced 2025-09-22) — the "Auth.js client patterns" question collapses into better-auth patterns going forward; new projects are pointed at better-auth ([announcement](https://better-auth.com/blog/authjs-joins-better-auth)).
- Next.js 16 renamed `middleware.ts` to `proxy.ts` and it now runs on the **Node.js runtime**; official guidance is still "optimistic checks only in Proxy (read the cookie, no DB), real checks in the Data Access Layer near the data" ([Next.js auth guide](https://nextjs.org/docs/app/guides/authentication), [better-auth Next integration](https://better-auth.com/docs/integrations/next)). Our adapter must support all three strategies: cookie-presence, stateless cookie-cache verify, full DB verify.
- tRPC's new TanStack integration is the design to copy for non-Effect data libraries: factories (`queryOptions`, `queryKey`) over a `useTRPC()` handle instead of bespoke hooks ([setup docs](https://trpc.io/docs/client/tanstack-react-query/setup)); TkDodo's `queryOptions` + DataTag pattern ("separating queryKey from queryFn was a mistake") validates exposing query-option factories rather than only hooks ([Query Options API](https://tkdodo.eu/blog/the-query-options-api)).
- CSRF client-side should be boring: cookie mode (default) = `SameSite=Lax` + signed double-submit token injected as a custom header on mutations by the client itself; server also validates Origin/`Sec-Fetch-Site` ([OWASP CSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).
- Recommend shipping adapters as thin packages implementing one minimal contract (mount handler, server session accessor, cookie-writer bridge, request translation) and validating them with `@effect-auth/test` contract tests; start with Next.js + Hono, then TanStack Start, SvelteKit/Nuxt later.

## Questions answered

### Q39 — Client generation: how much comes free from `HttpApiClient` vs a custom plugin client surface?

Evidence. `HttpApiClient.make(api, { baseUrl, transformClient, transformResponse })` returns a client whose shape is derived from the `HttpApi` groups/endpoints: top-level endpoints become methods, groups become nested objects; requests are encoded from endpoint schemas, responses and declared errors are decoded, and the *client's own service requirements* (including middleware marked `requiredForClient`) appear in the Effect type ([v4 HttpApiClient](https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiClient)). Finer-grained builders exist: `HttpApiClient.group`, `HttpApiClient.endpoint`, and `HttpApiClient.urlBuilder` (same layout, returns URLs — useful for server-side link generation and tests). Client middleware is first-class: `HttpApiMiddleware.Service(...)("id", { error, provides, requires, clientError, security, requiredForClient })` and `HttpApiMiddleware.layerClient` supply the `ForClient` marker the generated client requires — i.e., a plugin's middleware can wrap *client* requests too, not just server handlers ([v4 HttpApiMiddleware](https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiMiddleware)). Bearer-style client auth is doable via `transformClient` + `HttpClientRequest.bearerToken` ([HttpApiSecurity reference](https://www.effect.website/docs/v3/api/platform/HttpApiSecurity), [v4 HttpClientRequest](https://www.effect.website/docs/v4/api/effect/unstable/http/HttpClientRequest)). The PRD already commits to "the HTTP API definition drives server, client, OpenAPI" (PRD §5.4, §13.3, §22, ADR-003), and v4's immutable composition means the merged `AuthApi` (core + plugins) is assembled once and clients are generated from it — so a plugin's client API is its `HttpApiGroup` contribution; there is no separate client manifest to duplicate (answering Q29's mechanism as a side effect).

Free from `HttpApiClient` (verified against v3 + v4 references): endpoint methods named per group/endpoint; payload/query/param encoding from `Schema`; success decoding; declared-error decoding into the typed union (`ParseResult.ParseError` and `HttpClientError` included in the client channel); `group`/`endpoint`-scoped sub-clients; `urlBuilder` for typed URLs; OpenAPI doc generation; `transformClient`/`transformResponse` hooks; middleware participation via `requiredForClient`. Hand-written in `@effect-auth/client`: session store + `hydrate`; CSRF header injection; credentials policy per mode; `$ERROR_CODES` registry; promise wrappers (if the user opts in); non-browser token storage guidance.
The remaining gap is deliberate: nothing in Effect tracks "the current browser session," and frameworks differ in how they own cookies — that is the entire hand-written surface (plus the i18n catalog and optional promise wrappers above). Third-party codegen from OpenAPI (openapi-typescript, hey-api, orval) solves a problem we don't have — our schema is already TypeScript — but matters for consumers who *refuse* Effect: exposing the aggregated OpenAPI document (PRD §38) plus letting them codegen is the escape hatch, no extra client code from us ([orval](https://orval.dev/), [hey-api get started](https://heyapi.dev/docs/openapi/typescript/get-started)).

Risk: HttpApi is under `effect/unstable/httpapi` in v4 — API shapes may churn during the beta ([docs path](https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiClient)). Mitigate by pinning the Effect range (Q2) and funneling all HttpApi usage through one internal module.

**Recommendation:** Ship `@effect-auth/client` where ~90% of endpoint typing is `HttpApiClient.make(AuthApi)`; hand-write only `createAuthClient` (session store + CSRF + credentials/bearer policy + error codes). Plugins contribute client APIs *only* by declaring `HttpApiGroup`s — reject any separate client contribution API in the plugin contract; compile the client from the merged API. Expose the OpenAPI document for non-Effect consumers instead of maintaining a second client kind.
**Confidence:** high

### Q40 — What belongs in `@effect-auth/http` vs `@effect-auth/next|hono|tanstack|astro`; the minimal adapter contract?

Evidence. The PRD fixes the split (PRD §23, §41): `@effect-auth/client` is framework-agnostic; `@effect-auth/http` owns the HttpApi assembly, middleware, CSRF/cookie mechanics; framework packages "only translate framework-specific request/response objects into the core HTTP/API model". Field practice matches this shape: better-auth's Next integration is a route-handler mount (`toNextJsHandler`), a server-action cookie bridge (`nextCookies` plugin), and cookie helpers (`getSessionCookie`) — no business logic ([better-auth Next](https://better-auth.com/docs/integrations/next)). TanStack Start offers server-function middleware (`createMiddleware({ type: 'function' }).server(...)`) that composes and passes context into handlers ([TanStack middleware](https://tanstack.com/start/latest/docs/framework/react/guide/middleware.md)); SvelteKit's official integration point is a `hooks.server.ts` handle hook filling `event.locals` from cookies ([SvelteKit auth docs](https://svelte.dev/docs/kit/auth)); Nuxt's recipe is server utils (`requireUserSession`) plus a `useUserSession()` composable ([Nuxt sessions recipe](https://nuxt.com/docs/4.x/guide/recipes/sessions-and-authentication)). Hono needs no adapter at all for *serving* Effect if the app is served by Effect, but a Hono-mounted auth handler is a small middleware/`c.env` translation.

The minimal contract every adapter implements (five functions, nothing else):

1. **`authHandler(auth)`** → a framework-native request handler mounted at `/api/auth/*` (translates framework Request → Effect `HttpServerRequest`, runs the compiled router, copies Set-Cookie back). On fetch-compatible runtimes this is nearly free — Next route handlers, Hono, TanStack server routes, SvelteKit endpoints, Nuxt server routes all speak `Request`/`Response`.
2. **`getSession(input)`** → `Promise<Session | null>` from the framework's native headers/cookies object (Next `headers()`, Hono `c.req`, SvelteKit `event.request`, TanStack server fn context). Three strategies selectable: `cookie-presence` (edge-safe, optimistic), `cookie-cache` (stateless verify — signed cached session cookie), `database` (authoritative).
3. **`cookieBridge`** (only where a framework owns the cookie jar): writes `Set-Cookie` produced inside a server action/mutation through the framework's API — the `nextCookies()` pattern ([better-auth Next](https://better-auth.com/docs/integrations/next)).
4. **`principalMiddleware`** (server-context adapters: Hono, TanStack): attaches the resolved `CurrentPrincipal` to the framework's context object for non-HttpApi code (SSR loaders, server functions).
5. **client re-export**: the same `@effect-auth/client` configured with the framework's base URL/fetch conventions.

Contract tests in `@effect-auth/test` assert all five across adapters, so adapters stay ~200-line packages.

**Recommendation:** `@effect-auth/http`: AuthApi assembly, session middleware (`HttpApiMiddleware` with `requiredForClient` client counterpart), CSRF, cookie/bearer issuance, OpenAPI. Framework packages: only the five-item contract above. v1 ships `@effect-auth/next` + `@effect-auth/hono`; TanStack Start next (its server-function middleware maps 1:1 to `HttpApiMiddleware`); SvelteKit/Nuxt/Astro follow the same contract.
**Confidence:** high

### Q82 — Client surface: typed HttpApiClient + session helpers; cookie vs bearer modes; CSRF client-side

Evidence. Cookie sessions are the browser default everywhere in this ecosystem: better-auth uses cookie session management with configurable attributes and offers bearer only as a cautious opt-in plugin ("intended only for APIs that don't support cookies... improper implementation could easily lead to security vulnerabilities", token delivered via `set-auth-token` response header, stored in localStorage) ([bearer plugin](https://better-auth.com/docs/plugins/bearer), [session management](https://better-auth.com/docs/concepts/session-management)). Hono's typed client needs `credentials: 'include'` for cookies ([Hono RPC](https://hono.dev/docs/guides/rpc)) — the equivalent knob for us is an `HttpClient` layer configured with the right credentials policy. CSRF guidance (OWASP): `SameSite` alone is defense-in-depth, not a replacement; for AJAX/API sites the recommended combo is custom request headers (which force CORS preflight) + signed double-submit cookie bound to the session, plus Origin/`Sec-Fetch-Site` verification server-side; naive double-submit is explicitly discouraged ([OWASP CSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [Copenhagen Book CSRF](https://thecopenhagenbook.com/csrf)).

Proposed surface (`@effect-auth/client`, framework-agnostic):

```ts
export const authClient = AuthClient.make({
  baseUrl: "https://api.example.com",
  mode: "cookie" /* default */ | "bearer",
  csrf: { headerName: "x-csrf-token" },     // cookie mode only
  session: { refetchOnWindowFocus: true },  // mirrors better-auth sessionOptions
})
authClient.api.password.signIn({ body })     // Effect, typed errors — from HttpApiClient
authClient.session.get()                     // Session | null (Effect or promise)
authClient.session.hydrate(initialSession)   // SSR seeding, first non-null wins
authClient.$ERROR_CODES                      // const object of stable code strings
```

Client middleware does CSRF injection: a `transformClient` that reads the non-httpOnly `csrf` cookie (set by the server on session start) and adds the header to unsafe methods; the server validates token + Origin/`Sec-Fetch-Site` in `@effect-auth/http`. Bearer mode skips CSRF (no ambient credentials) and is documented as non-browser-only.

**Recommendation:** Cookie mode default (`Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` prefix option); bearer opt-in plugin with loud warnings, mirroring better-auth. CSRF: server issues signed double-submit token bound to the session id; client auto-attaches it as a custom header on POST/PUT/PATCH/DELETE; server additionally verifies Origin/`Sec-Fetch-Site` with documented fallback for older browsers. Ship `session.get/hydrate/refresh` helpers on the vanilla client so every framework binding is thin.
**Confidence:** high

### Q83 — React package: `useSession`/`useAuth` patterns, TanStack Query integration, SSR/RSC

Evidence. better-auth's React hooks return `{ data, isPending, error, refetch }`, live on nanostores so the same store powers Vue/Svelte/Solid, refetch on window focus / interval is configurable (`sessionOptions`), and SSR loading flashes are solved by `hydrateSession(initialSession)` — pass the server-fetched session down from an RSC and use it until the first client fetch lands ([client docs](https://better-auth.com/docs/concepts/client)). RSC caveats are real: RSCs cannot set cookies, so cookie-cache refresh needs server actions/route handlers — hence better-auth's `nextCookies` plugin ([Next integration](https://better-auth.com/docs/integrations/next)). In the Effect world, `@effect-atom/atom-react` provides exactly this shape natively: `Atom.runtime(layer)`, `useAtomValue`/`useAtomSet`, `Result`-typed effectful atoms, `ReactHydration` for SSR, and `AtomHttpApi.query/mutation` typed straight from an `HttpApi` with `reactivityKeys` invalidation ([effect-atom](https://github.com/tim-smart/effect-atom)). For TanStack Query users, the tRPC integration is the modern template: expose `queryOptions`/`mutationOptions` factories and a `useTRPC()`-style handle rather than a bespoke hook per method ([tRPC TanStack setup](https://trpc.io/docs/client/tanstack-react-query/setup)); TkDodo's guidance is to co-locate queryKey with queryFn via `queryOptions` and lean on DataTag typing ([Query Options API](https://tkdodo.eu/blog/the-query-options-api), [Effective React Query Keys](https://tkdodo.eu/blog/effective-react-query-keys)).

Proposed shape for `@effect-auth/react` (thin — depends on `@effect-auth/client`):

```tsx
// root
<AuthClientProvider client={authClient} runtime={ClientLive}> // Atom runtime over HttpClient layer
// hooks
useSession()        // { data, isPending, error, refetch } — atom-backed, keepAlive
useAuthAction(m)    // mutation wrapper: { mutate, isPending, error: AuthError | null }
hydrateSession(s)   // SSR bridge, better-auth semantics
// opt-in TanStack adapter: @effect-auth/react-query
sessionQueryOptions(client)            // queryKey: ['auth','session'], DataTagged
apiQueryOptions(client, group, ep)     // tRPC-style factories over HttpApiClient
```

SSR/RSC: server components call the adapter's `getSession(headers)` (Effect runtime server-side, no client bundle cost), pass `initialSession` to `hydrateSession`; `useSession` renders from the hydrated value. For TanStack users, `sessionQueryOptions` seeds via `initialData` (TkDodo's "Seeding the Query Cache" pattern) and invalidates on sign-in/out.

Session cache semantics the React package must own (mirroring better-auth's atom signals, expressed as an invalidation matrix):

| Client event | Session cache effect |
|---|---|
| sign-in / sign-up success | revalidate `['auth','session']`; server set session cookie in response |
| sign-out success | set session to `null`; clear plugin-scoped caches |
| session endpoint 401 | set `null` (treat as logged out; never surface raw 401 to UI) |
| window focus (if enabled) | background refetch (`refetchOnWindowFocus`) |
| `hydrateSession(initial)` | first non-null call seeds; later calls ignored |
| `disableSignal`-style opt-out | mutation completes without touching session atom (manual `refetch` if needed) |

**Recommendation:** Build `@effect-auth/react` on `@effect-atom/atom-react` (session = keepAlive result atom; `AtomHttpApi` under the hood for Effect-native consumers), and ship a small `@effect-auth/react-query` adapter exporting `queryOptions` factories for TanStack shops. Do not invent a bespoke reactive store. Copy better-auth's `hydrateSession` SSR contract verbatim (first non-null call wins) and its hook return shape.
**Confidence:** high (on the React shape), medium (on atom vs TanStack as the primary primitive — see open questions)

### Q84 — Next.js: App Router integration, Proxy/middleware (edge) constraints, server actions vs route handlers

Evidence. Current Next.js docs (v16.3.5, updated 2026-08-25) confirm: middleware is renamed **Proxy** (`proxy.ts`), runs on the **Node.js runtime** in Next 16 (edge runtime for Next ≤15.1; Node middleware experimental 15.2–15.x), and the official recommendation is optimistic cookie-only checks in Proxy with real authorization in a Data Access Layer close to the data — "since Proxy runs on every route... only read the session from the cookie... and avoid database checks" ([Next.js auth guide](https://nextjs.org/docs/app/guides/authentication), [Auth.js edge guide](https://authjs.dev/guides/edge-compatibility)). better-auth implements exactly the tiers we should support: `getSessionCookie(request)` presence check (labeled "THIS IS NOT SECURE! ... recommended approach to optimistically redirect users"), full `auth.api.getSession` in Node-runtime Proxy, and for edge-era code either a fetch to `/api/auth/get-session` or a stateless cookie-cache verify ([better-auth Next](https://better-auth.com/docs/integrations/next)). For login UI, Next.js recommends `<form>` + Server Actions + `useActionState`, with server-side validation; cookies set inside server actions require the `next/headers` cookie API — hence a cookie-writing plugin (`nextCookies()`, must be the last plugin) ([Next.js auth guide](https://nextjs.org/docs/app/guides/authentication), [better-auth Next](https://better-auth.com/docs/integrations/next)). Route Handlers remain the way to mount the HTTP API; layouts must not be trusted for auth checks because partial rendering skips them on navigation, and layout-level `await cookies()` delays streaming ([Next.js auth guide](https://nextjs.org/docs/app/guides/authentication)).

Session-check strategy matrix for `@effect-auth/next` (who may run where):

| Strategy | Mechanism | Runs in Proxy (Node, 16+) | Runs in Proxy (edge, ≤15.1) | Secure enough alone? | Use for |
|---|---|---|---|---|---|
| `cookie-presence` | `getSessionCookie(request)` — name/prefix match only | yes | yes | no (explicitly optimistic) | redirects, UI gating |
| `cookie-cache` | verify signed cached-session cookie (HMAC/stateless) | yes | yes (WebCrypto only) | partially — freshness limited | edge-era Proxy, high-traffic gate |
| `database` | full `getSession` → store lookup | yes | no (no native DB drivers; would need HTTP round-trip) | yes | DAL, server components, server actions, route handlers |

**Recommendation:** `@effect-auth/next` ships: (1) `toNextRouteHandler(auth)` for `/api/auth/[...all]`; (2) `getSession({ headers } | { cookies })` with the three strategies (`cookie-presence` | `cookie-cache` | `database`), defaulting to `cookie-presence` in Proxy and `database` in the DAL; (3) a `nextCookies()`-style plugin so `Set-Cookie` from server actions works; (4) docs/recipe: DAL function `requireSession()` using React `cache()`, DTO trimming, `<Suspense>` around session-dependent shell parts, `redirect()` from server actions. Document explicitly that Proxy is optimization/UX, never the security boundary — and that on Next ≤15 edge Proxy only the presence or stateless strategies work (no native DB drivers).
**Confidence:** high

### Q85 — Minimal adapter contract for Hono / TanStack Start / Astro / SvelteKit — what does an adapter actually do?

Evidence (per-framework integration points, verified 2026-09):

- **Hono** (Yusuke Wada): middleware chain + typed RPC client `hc<AppType>` with `credentials: 'include'` for cookies; global error shapes are *not* auto-inferred into the client (`ApplyGlobalResponse` needed) — a caution that our HttpApi error union must stay explicit ([Hono RPC](https://hono.dev/docs/guides/rpc)). Adapter = one middleware translating `c.req.raw` (a fetch `Request`) into the Effect router, plus `getSession(c)` helper.
- **TanStack Start**: server functions via `createServerFn`, full-stack cookie sessions (`useSession`), route protection via `beforeLoad`, and — the key seam — **server-function middleware** `createMiddleware({ type: 'function' })` with `.client()/.server()/.validator()` that composes and passes context; docs are explicit that `beforeLoad` is route UX, not the data boundary ("Apply authMiddleware or an equivalent in-handler check to every server function that reads or writes private data") ([authentication](https://tanstack.com/start/latest/docs/framework/react/guide/authentication.md), [middleware](https://tanstack.com/start/latest/docs/framework/react/guide/middleware.md), [server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)). Adapter = authHandler for the API routes + a `principal` server-function middleware + client via `@effect-auth/react`.
- **SvelteKit**: integration point is `hooks.server.ts` — check auth cookies, store user on `event.locals`; official docs recommend the Lucia guide's session pattern and offer Better Auth setup via the Svelte CLI ([SvelteKit auth](https://svelte.dev/docs/kit/auth)). Adapter = handle hook + `getSession(event)` + client store (Svelte 5 runes or vanilla `@effect-atom/atom` subscription).
- **Astro**: middleware + `Astro.locals`, server islands; no first-party auth primitives — an adapter is request translation plus docs ([INFERENCE: not separately verified this cycle; same contract applies]).
- **Nuxt**: `nuxt-auth-utils` (by Sébastien Chopin) defines the idiom: server utils (`requireUserSession`, `UserSession` on `event.context`) + `useUserSession()` composable with `loggedIn`/`user`/`fetch` ([Nuxt recipe](https://nuxt.com/docs/4.x/guide/recipes/sessions-and-authentication), [module page](https://nuxt.com/modules/auth-utils)). Adapter mirrors that API surface backed by our session endpoint.

All of these collapse onto the five-item contract from Q40 (handler mount, session accessor with strategies, cookie bridge where the framework owns cookies, principal middleware for server contexts, client re-export). The adapter never contains auth logic; it contains translation.

Contract-to-framework mapping (what each adapter item binds to):

| Contract item | Next.js | Hono | TanStack Start | SvelteKit | Nuxt |
|---|---|---|---|---|---|
| `authHandler` | route handler `/api/auth/[...all]` (`Request`/`Response`) | `app.route()` middleware on fetch `Request` | server-route `Request` handler | `+server.ts` endpoints / handle hook fallback | server route `/api/auth/*` |
| `getSession` | `headers()` / `cookies()` | `c.req.header('cookie')` | server-fn request headers | `event.request.headers`, `locals` | `getRequestHeader(event)` |
| `cookieBridge` | required (server actions own the jar — `nextCookies`-style) | not needed (handler writes Set-Cookie) | not needed (server fns write cookies) | not needed (`event.cookies` written by handler) | analogous to auth-utils `setUserSession` |
| `principalMiddleware` | RSC/DAL helper (`React.cache`) | Hono middleware → `c.set('principal')` | `createMiddleware({type:'function'}).server(...)` context | handle hook → `event.locals` | server util `requireUserSession(event)` |
| client re-export | `@effect-auth/react` | vanilla/`@effect-atom/atom` | `@effect-auth/react` | svelte binding over vanilla store | `useUserSession`-shaped composable |

**Recommendation:** Publish the five-item contract as a typed interface + contract-test suite in `@effect-auth/test` before writing any adapter; each adapter is then mechanical. Order: Next.js (dominant demand), Hono (cheapest to prove the contract), TanStack Start (validates the server-context middleware story), SvelteKit, Nuxt, Astro.
**Confidence:** high

### Q86 — Client error typing: surfacing the typed error union to UI, safe messages, i18n

Evidence. Effect gives the transport: `HttpApiClient` decodes declared error schemas, so the UI-side error union is exactly the endpoint's `addError`/group/`clientError` union ([v4 HttpApiClient](https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiClient)). better-auth's client is the i18n benchmark: responses carry stable string `code`s, `authClient.$ERROR_CODES` exposes the full code union as a type, and apps map codes → localized messages ([client docs, Error Codes section](https://better-auth.com/docs/concepts/client)). Hono's RPC shows the failure mode to avoid: un-typed global errors leak into clients as uninferable payloads ([Hono RPC](https://hono.dev/docs/guides/rpc)). Enumeration safety requires user-facing messages to be uniform regardless of which internal branch fired (see Q90 research; PRD §29 already separates user-facing messages from internal detail).

Proposed wire envelope (stable, schema-decodable on both sides):

```json
// 401 response body for sign-in with wrong password
{ "code": "INVALID_CREDENTIALS", "status": 401, "message": "Invalid email or password." }
// 422 from HttpApiError (schema validation)
{ "code": "VALIDATION_ERROR", "status": 422, "details": { "fieldErrors": { "email": ["Expected a valid email"] } } }
```

The client-side catalog type-checks against the union:

```ts
const messages = {
  INVALID_CREDENTIALS: { en: "Invalid email or password.", es: "Correo o contraseña incorrectos." },
  RATE_LIMITED:        { en: "Too many attempts. Try again later.", es: "Demasiados intentos. Inténtalo más tarde." },
} satisfies Partial<Record<typeof authClient.$ERROR_CODES, Record<"en" | "es", string>>>
```

**Recommendation:** Every `Schema.TaggedError` in auth APIs carries: `_tag` (discriminant), `code` (stable machine string, e.g. `INVALID_CREDENTIALS`), `status`, and an optional `detail` — never raw provider/DB messages; wire format is a small problem-details-inspired envelope. `@effect-auth/client` re-exports `$ERROR_CODES` derived from the compiled API (type-level union of all codes) and a helper `toUserMessage(error, messages | t)` that returns catalog[code] with a safe fallback. Docs pattern: a `messages.en/es` record `satisfies Record<typeof authClient.$ERROR_CODES, {en; es}>` — better-auth's pattern verbatim. Validation failures (422 `HttpApiError`) surface field-level issues via the schema's decoded output. The typed union flows for free; the only core work is the code registry + redaction rules.
**Confidence:** high

### Q87 — SPA/BFF guidance: topologies and what the library enforces vs documents

Evidence. Three viable topologies exist in the wild: (1) **same-origin full-stack** (Next/Hono/SvelteKit serve UI + API): cookies with `SameSite=Lax`, no CORS, simplest CSRF story — the default for every library here (better-auth docs assume same-origin baseURL-less setup by default [client docs](https://better-auth.com/docs/concepts/client)); (2) **BFF**: SPA origin + separate API origin behind a server-side proxy that holds the httpOnly cookie — the strong recommendation for token-safety in the SPA era and what "optimistic session" Next patterns presuppose ([Next.js auth guide](https://nextjs.org/docs/app/guides/authentication)); (3) **cross-origin SPA/API**: requires CORS + `credentials: 'include'`, `SameSite=None; Secure` cookies (third-party-cookie hostile) or bearer tokens for native clients ([bearer plugin](https://better-auth.com/docs/plugins/bearer)). OWASP: SameSite is defense-in-depth; custom-header requirements and Origin checks are the API-grade controls ([OWASP CSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).

Topology decision table (what changes per deployment):

| | Same-origin full-stack | BFF (proxy in front of API) | Cross-origin SPA + API |
|---|---|---|---|
| Session cookie scope | host-only, `SameSite=Lax` | httpOnly cookie held by BFF, session token forwarded internally | `SameSite=None; Secure` (or bearer) |
| CORS | none needed | none for browser; internal hop only | required + `trustedOrigins` allowlist |
| CSRF control needed | custom-header + Origin check | origin check at BFF; browser sees one origin | signed double-submit mandatory; Origin + `Sec-Fetch-Site` |
| Token exposure risk | none in JS | none in JS (cookies stay with BFF) | cookie readable only if not httpOnly — keep httpOnly; bearer → localStorage risk |
| Native clients | n/a | n/a (public API surface needed) | bearer mode |
| effect-auth posture | default | recommended for split origins | expert mode, explicit config |

**What effect-auth should enforce (non-negotiable defaults):** secure cookie attributes by default (`Secure`, `HttpOnly`, `SameSite=Lax`, host-only, optional `__Host-` prefix), CSRF validation on all unsafe-method endpoints when cookie auth is active, Origin/`Sec-Fetch-Site` verification middleware, no tokens in URLs, bearer mode explicitly opted in. **What it should document (not enforce):** CORS trusted-origin config, cross-subdomain cookie scoping (and its risks), BFF proxy recipes per platform, CSP (framework concern), per-deployment choices between the three topologies with a decision table.

**Recommendation:** Default docs to topology (1), present BFF as the recommended evolution for split origins, and treat cross-origin SPA + cookie as expert mode with explicit `trustedOrigins` + `SameSite=None` configuration. Enforce the security floor in `@effect-auth/http` (it ships in the middleware, not in docs); keep topology wiring in recipes. Native clients (React Native etc.) get the bearer plugin + token storage guidance pointing at OS keystores.
**Confidence:** high

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
|---|---|---|---|---|
| Effect HttpApi/HttpApiClient (v3.22 stable, v4 beta `effect/unstable/httpapi`) | Schema-first API + generated typed client, middleware, urlBuilder | MIT | Core of Effect; HttpApi hardening landed July 2026 ([recap](https://www.effect.website/blog/effect-v4beta-july-recap)) | The generated-client foundation (Q39) |
| [@effect-atom/atom-react](https://github.com/tim-smart/effect-atom) | Reactive atoms over Effect Layers; `AtomHttpApi`, hydration | MIT | Active, 792★, Effect-core authored | Substrate for `@effect-auth/react` session/hooks (Q83) |
| [better-auth](https://better-auth.com/docs/concepts/client) 1.7.4 | TS auth framework; plugin-extensible clients, hooks, `$Infer` | MIT | Dominant in its niche; absorbed Auth.js (2025-09) | Client UX benchmark; framework adapter patterns |
| [nanostores](https://github.com/nanostores/nanostores) | Tiny framework-agnostic store | MIT | Stable | Why better-auth hooks work across React/Vue/Svelte/Solid |
| [@trpc/tanstack-react-query](https://trpc.io/docs/client/tanstack-react-query/setup) 11.18 | tRPC↔TanStack Query factories (`queryOptions`, `queryKey`) | MIT | tRPC-recommended integration | Template for `@effect-auth/react-query` factories (Q83) |
| [@tanstack/react-query](https://tanstack.com/query/latest) 5.102 | Cache/query state lib | MIT | Ubiquitous | Target for non-Effect data consumers |
| [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/guide/middleware.md) 1.168 | Full-stack React: server fns, server-fn middleware, `beforeLoad` | MIT | Active | Adapter with middleware-shaped server context (Q85) |
| [Hono](https://hono.dev/docs/guides/rpc) 4.13.7 | Web-standard framework; `hc` typed RPC client | MIT | Very popular (Wada) | Adapter target; cautionary tale on error inference |
| [Next.js](https://nextjs.org/docs/app/guides/authentication) 16.3 docs | App Router, Server Actions, Proxy (Node runtime) | MIT | Dominant React meta-framework | `@effect-auth/next` surface (Q84) |
| [SvelteKit](https://svelte.dev/docs/kit/auth) | hooks.server.ts + `locals` auth idiom | MIT | Stable | Adapter target (Q85) |
| [Nuxt](https://nuxt.com/docs/4.x/guide/recipes/sessions-and-authentication) 4.x + [nuxt-auth-utils](https://nuxt.com/modules/auth-utils) | `requireUserSession` + `useUserSession` idiom | MIT | Official recipe pattern | Adapter target (Q85) |
| [openapi-typescript](https://openapi-typescript.com/) 7.13 / [@hey-api/openapi-ts](https://heyapi.dev/docs/openapi/typescript/get-started) 0.99 / [orval](https://orval.dev/) 8.31 | OpenAPI → types/clients (+ TanStack/SWR/mocks) | MIT | Active | Only relevant as the OpenAPI escape hatch for non-Effect consumers (Q39) |
| [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) | Defense standard: signed double-submit, Fetch Metadata | Document | Continuously updated | CSRF defaults (Q82, Q87) |

## Books, papers, blogs, talks

- [The Query Options API — TkDodo](https://tkdodo.eu/blog/the-query-options-api) — why queryOption factories + DataTag beat hook-only APIs; direct input to `@effect-auth/react-query`.
- [Effective React Query Keys — TkDodo](https://tkdodo.eu/blog/effective-react-query-keys) — key factories, hierarchical invalidation; session keys (`['auth','session']`) and post-login invalidation design.
- [Practical React Query — TkDodo](https://tkdodo.eu/blog/practical-react-query) — treat the query key as the dependency array; underpins "session as query" semantics.
- [tRPC: TanStack React Query setup](https://trpc.io/docs/client/tanstack-react-query/setup) + [integration announcement discussion](https://github.com/trpc/trpc/discussions/6508) — the factories-not-hooks pattern to copy.
- [tRPC: Set up with React Server Components](https://trpc.io/docs/client/tanstack-react-query/server-components) — candid "RSC solves much of what tRPC did"; positions client libraries honestly vs RSC.
- [better-auth client concepts](https://better-auth.com/docs/concepts/client) — hooks shape, `hydrateSession`, `$ERROR_CODES`, signal/re-render control (`disableSignal`); our DX checklist.
- [better-auth Next.js integration](https://better-auth.com/docs/integrations/next) — Proxy tiers, `nextCookies`, `getSessionCookie`; the adapter to outdo.
- [Next.js guide: Authentication](https://nextjs.org/docs/app/guides/authentication) — Proxy optimistic checks, DAL, DTO, server-action login, layout caveats, streaming push-down.
- [Auth.js: Edge Compatibility](https://authjs.dev/guides/edge-compatibility) — the clearest explanation of edge-vs-Node DB constraints and split-config; now Better Auth-maintained.
- [Hono RPC guide](https://hono.dev/docs/guides/rpc) — typed client from server types, cookie credentials, `ApplyGlobalResponse` error-inference gap.
- [TanStack Start: Authentication](https://tanstack.com/start/latest/docs/framework/react/guide/authentication.md) & [Middleware](https://tanstack.com/start/latest/docs/framework/react/guide/middleware.md) — server functions, session cookies, beforeLoad-as-UX-not-boundary.
- [SvelteKit auth docs](https://svelte.dev/docs/kit/auth) + [Lucia guides](https://lucia-auth.com/) — sessions-vs-tokens framing and the `locals` integration point.
- [Nuxt sessions recipe](https://nuxt.com/docs/4.x/guide/recipes/sessions-and-authentication) — `useUserSession` idiom.
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — signed double-submit (recommended) vs naive (discouraged), Fetch Metadata policy, custom-header rule for AJAX.
- [The Copenhagen Book — CSRF](https://thecopenhagenbook.com/csrf) — practitioner summary incl. subdomain takeover caveat.
- [effect-atom docs](https://tim-smart.github.io/effect-atom/) — `Atom.runtime`, `Result` atoms, `ReactHydration`; reads as a preview of Effect-native frontend idioms.
- [Effect v4 beta: July 2026 recap](https://www.effect.website/blog/effect-v4beta-july-recap) — HttpApi hardening inventory; Atom/reactivity fixes; repo migration.
- [Auth.js joins Better Auth](https://better-auth.com/blog/authjs-joins-better-auth) — consolidation of the JS auth-client landscape; migration guidance posture.

## People & projects to follow

- **Dominik "TkDodo" Dorfmeister** — TanStack Query maintainer; the queryOptions/queryKey canon ([blog](https://tkdodo.eu/blog), [@tkdodo](https://x.com/tk_dodo)).
- **Alex Johansson (KATT)** — tRPC author; the `@trpc/tanstack-react-query` redesign ([trpc](https://trpc.io), [@alexdotjs](https://x.com/alexdotjs)).
- **Yusuke Wada** — Hono author; web-standard framework + `hc` client ([hono](https://hono.dev), [@yusukebe](https://x.com/yusukebe)).
- **Tim Smart** — Effect core team; author of effect-atom (the Effect-native React reactivity path) ([github](https://github.com/tim-smart)).
- **Bereket Engida (bekacru)** — better-auth creator; now also oversees Auth.js ([better-auth](https://better-auth.com), [@bekacru](https://x.com/bekacru)).
- **Balázs Orbán** — former Auth.js/NextAuth lead, now with Better Auth ([announcement credits](https://better-auth.com/blog/authjs-joins-better-auth)).
- **Sébastien Chopin (atinux)** — nuxt-auth-utils author; the Nuxt session idiom ([nuxt-auth-utils](https://nuxt.com/modules/auth-utils)).
- **Lucia (Pilcrow)** — learning resource author; deprecated the library in favor of framework-agnostic session guides ([lucia-auth.com](https://lucia-auth.com/)).
- **Tanner Linsley** — TanStack Query/Start/Router author; server-function middleware and loader direction ([tanstack.com](https://tanstack.com), [@tannerlinsley](https://x.com/tannerlinsley)).

## Recommended defaults for effect-auth

1. **Client = HttpApiClient + a thin session shell.** `@effect-auth/client` exposes `AuthClient.make({ baseUrl, mode, csrf, session })` returning `{ api, session, $ERROR_CODES }`. `api` is `HttpApiClient.make(AuthApi)`; nothing about endpoints is hand-written (Q39).
2. **Plugin client contributions = HttpApiGroups only.** The compiled client derives from the merged API; the plugin contract rejects any parallel "client API" declaration (PRD §22; Q39).
3. **Cookie mode by default, bearer opt-in.** `Secure; HttpOnly; SameSite=Lax` defaults, `__Host-` prefix option, configurable prefix/names that adapters can read (`getSessionCookie(request)` helper like better-auth's). Bearer ships as a plugin with non-browser guidance (Q82, Q87).
4. **CSRF: signed double-submit + Origin/Sec-Fetch-Site, client-injected header.** Server issues a token bound to session id in a readable cookie; client middleware adds `x-csrf-token` to unsafe methods; server validates both. Naive double-submit and token-less flows are rejected in review (Q82).
5. **Session helpers on the vanilla client**: `session.get/refresh/signOut`, `session.hydrate(initial)` (first non-null wins), `refetchOnWindowFocus`/`refetchInterval` options — copied from better-auth semantics (Q83).
6. **`@effect-auth/react` built on `@effect-atom/atom-react`**: `AuthClientProvider`, `useSession()` → `{ data, isPending, error, refetch }`, `useAuthAction`, `hydrateSession`; ships `@effect-auth/react-query` with `queryOptions`/`mutationOptions` factories (tRPC-style, DataTag-typed) for TanStack shops (Q83).
7. **Error wire format**: envelope `{ code, status, message?, details? }` with stable `code`s; `$ERROR_CODES` type derived from the API; `toUserMessage(error, catalog)` helper; uniform responses on enumeration-sensitive endpoints (Q86).
8. **Adapter contract of five functions** (handler mount, session accessor with `cookie-presence | cookie-cache | database` strategies, cookie bridge, principal middleware, client re-export), enforced by `@effect-auth/test` contract tests; v1 adapters: Next.js + Hono (Q40, Q85).
9. **Next.js story**: route handler mount; Proxy guidance = optimistic cookie check only; server actions need the `nextCookies`-style bridge plugin; DAL recipe with React `cache()`; never trust layouts; stream session-dependent shells via `<Suspense>` (Q84).
10. **Topology docs**: default same-origin; BFF recommended for split origins; cross-origin SPA cookie mode is expert configuration with `trustedOrigins` + `SameSite=None`; native clients → bearer plugin. Security floor is enforced in `@effect-auth/http`, not documented (Q87).
11. **Effect-version risk**: HttpApi is `unstable` in v4 — pin the supported range, confine all HttpApi imports to one internal module, and re-verify against each beta recap before bumping (Q39).
12. **OpenAPI as the escape hatch**: publish the aggregated spec (PRD §38) so non-Effect consumers can codegen with openapi-typescript/hey-api/orval instead of us maintaining a second client (Q39).

## Open questions for the user

1. **React primitive priority** — which is the primary, docs-first binding? Options: (a) Atom/effect-atom-first (most Effect-native, extra dep); (b) TanStack Query adapter-first (largest audience, no atom dependency); (c) minimal built-in store + both adapters equally.
2. **Bearer plugin at v1?** Options: (a) ship opt-in bearer at v1 (native clients early); (b) document "use a JWT plugin instead" and defer bearer; (c) v1 cookie-only, bearer + JWT in v1.1.
3. **Adapter scope at MVP** — options: (a) Next.js only; (b) Next.js + Hono (proves the contract cheaply); (c) Next.js + Hono + TanStack Start.
4. **CSRF default strictness** — options: (a) signed double-submit always on for cookie mode (recommended); (b) SameSite=Lax + Origin check only, token via opt-in; (c) config default (a) with BFF exemption flag.
5. **Promise-mode client for non-Effect apps** — should `authClient.api.*` also offer promise-returning variants (better-auth ergonomics for React devs who don't use Effect), or is Effect-typed-only correct for v1? Options: (a) Effect-only; (b) dual-mode with `Effect.runPromise` wrapper generated; (c) Effect-only + separate tiny `fetch`-based legacy client.

## Sources

- https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiClient
- https://www.effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiMiddleware
- https://www.effect.website/docs/v3/api/platform/HttpApiClient
- https://www.effect.website/docs/v3/api/platform/HttpApi
- https://www.effect.website/docs/v3/api/platform/HttpApiSecurity
- https://www.effect.website/docs/v4/api/effect/unstable/http/HttpClientRequest
- https://www.effect.website/blog/effect-v4beta-july-recap
- https://better-auth.com/docs/concepts/client
- https://better-auth.com/docs/integrations/next
- https://better-auth.com/docs/plugins/bearer
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/blog/authjs-joins-better-auth
- https://authjs.dev/guides/edge-compatibility
- https://nextjs.org/docs/app/guides/authentication
- https://trpc.io/docs/client/tanstack-react-query/setup
- https://trpc.io/docs/client/tanstack-react-query/server-components
- https://github.com/trpc/trpc/discussions/6508
- https://tkdodo.eu/blog/the-query-options-api
- https://tkdodo.eu/blog/effective-react-query-keys
- https://tkdodo.eu/blog/practical-react-query
- https://tanstack.com/start/latest/docs/framework/react/guide/authentication.md
- https://tanstack.com/start/latest/docs/framework/react/guide/middleware.md
- https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
- https://hono.dev/docs/guides/rpc
- https://svelte.dev/docs/kit/auth
- https://nuxt.com/docs/4.x/guide/recipes/sessions-and-authentication
- https://nuxt.com/modules/auth-utils
- https://github.com/tim-smart/effect-atom
- https://raw.githubusercontent.com/tim-smart/effect-atom/main/docs/atom/AtomHttpApi.ts.md
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://thecopenhagenbook.com/csrf
- https://heyapi.dev/docs/openapi/typescript/get-started
- https://orval.dev/
- https://github.com/orval-labs/orval
- npm registry version checks (2026-09-12): effect@3.22.2, better-auth@1.7.4, @trpc/tanstack-react-query@11.18.0, @tanstack/react-query@5.102.8, @tanstack/react-start@1.168.52, hono@4.13.7, openapi-typescript@7.13.0, @hey-api/openapi-ts@0.99.0, orval@8.31.0, nanostores@1.5.3
