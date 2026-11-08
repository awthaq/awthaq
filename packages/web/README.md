# @awthaq/web

The framework-neutral core of a web adapter (BO-004). `@awthaq/next` is the Next.js adapter built on it; an Astro or SvelteKit adapter reuses the same pieces and adds only its framework's own glue. Nothing in this package imports a framework.

| Export | What it does |
| --- | --- |
| `getSession(headers, runtime)` | The database-verified boundary (BEH-EA-185): resolves `{ principal, user, session, rotated }` under the runtime's `SessionCookieConfig` (IC-007), or `undefined` for a missing, malformed, expired or unknown-session cookie. |
| `makeGetSession(resolveCookieHeader)` | The same function over an injected `resolveCookieHeader(cookieHeader, runtime)` (the whole cookie-header resolution, `resolveSessionCookies`), so an adapter can dedupe per render (`@awthaq/next` passes `React.cache(resolveSessionCookies)`). |
| `applyRotatedSession(session, jar)` | Delivers a rotated session cookie (`session.rotated.cookie`, rendered under the configured name and attributes) into a mutable cookie jar (BO-001). |
| `hasSessionCookie(request, cookie)` | The presence-only, proxy/middleware check (BEH-EA-188). `cookie` is the partial given to `SessionCookie.config` (`{}` for the default). Never the boundary. |
| `applyResponseCookies(response, jar)` | Writes every `Set-Cookie` a `Response` carries into a framework cookie jar (BEH-EA-189). |
| `makeInProcessClient(api, options)` / `inProcessClient(api, options)` | A typed `HttpApiClient` over your own composed web handler for server actions: forwards the caller's cookies, echoes `__Host-csrf` as `x-csrf-token`, retries the cold-start CSRF rejection once, and lands every `Set-Cookie` in the jar (BEH-EA-189/190). |
| `UserAgent.make(options)` / `UserAgent.client(agent, api)` | An in-process user agent over a web handler (BEH-EA-344): an RFC 6265 cookie store, the CSRF echo, bearer delivery that follows `set-auth-token`/`x-awthaq-session-ended`, cross-site simulation. The in-process client is built on it; `@awthaq/test`'s `TestAuth.app` hands them out. |
| `@awthaq/web/cookies` | The edge-safe subpath: `findCookieValue`, `hasCookie`, `parseCookieHeader`, `hasSessionCookie`, `parseSetCookie`, `decodeCookieValue`, `applyResponseCookies`, `setCookie`, `makeCookieStore`, `isSecureOrigin` and the jar and store types, with no `@awthaq/core`/`@awthaq/server` in the import graph. |

## The cookie jar

`CookieJarLike` is one method, `set(name, value, options)`, where `options.path` is always present (BO-010). That is what lets one interface accept every framework's jar structurally:

- Next: `await cookies()` (`ResponseCookies`).
- SvelteKit: `event.cookies` (`Cookies.set` requires `path`).
- Astro: `Astro.cookies` (`AstroCookies.set`).

A `Set-Cookie` without a `Path` attribute is written with `path: "/"`. A compile-time test (`test/CookieJar.test.ts`) pins the SvelteKit and Astro shapes.

## Writing an adapter

```ts
// SvelteKit hooks.server.ts (sketch)
import { getSession } from "@awthaq/web";

export const handle = async ({ event, resolve }) => {
  event.locals.session = await getSession(event.request.headers, runtime);
  return resolve(event);
};

// a form action
import { inProcessClient } from "@awthaq/web";

export const actions = {
  signIn: async ({ request, cookies }) => {
    const client = await inProcessClient(AppApi, { handler, headers: request.headers, jar: cookies });
    await client.password.signIn({ payload });
  },
};
```

## The user agent

`UserAgent.make({ handler })` behaves like a browser against an awthaq handler (`(Request) => Promise<Response>`, or `fetch` for a server over the network). Its cookie store follows RFC 6265bis: `Max-Age` over `Expires`, the default path, host-only cookies versus `Domain`, path and domain matching, `Secure`, and `SameSite` by the request's site. It has two policies:

- `browser` (the default) refuses what a conforming browser refuses (the `__Host-`/`__Secure-` prefix rules, a `Secure` cookie from an insecure origin, `SameSite=None` without `Secure`, a mismatched `Domain`) and by default fails the request (`onRefused: "record"` keeps it in `agent.refused`).
- `trusted` is a server action calling its own application: `Domain`, `Secure` and `SameSite` are not enforced; expiry and `Path` are.

```ts
const browser = UserAgent.make({ handler });
await browser.request("POST", "/password/sign-in", { json: { email, password } }); // the session lands in its store
await browser.request("GET", "/session");                                       // ...and is sent back
browser.cookies.get("__Host-session");                                           // attributes included
await browser.request("GET", "/oauth/acme/callback?code=…", { site: "cross-site", navigation: true });

const native = UserAgent.make({ handler, delivery: "bearer" }); // X-Awthaq-Token-Delivery + Authorization, no cookies
```

`request` is a page script: it echoes `__Host-csrf` as `x-csrf-token` on an unsafe method. `fetch` and `httpClient` are the network and add no echo; `UserAgent.client(agent, api)` is a typed `HttpApiClient` over the agent with `AuthClient.csrfClientLayer` reading its store. A fresh agent's first unsafe request carries no `Cookie` header and passes `CsrfProtection`'s cookie-less exemption (BEH-EA-077). `inProcessClient` is this agent under the `trusted` policy, seeded with the action's incoming cookies and mirroring every `Set-Cookie` into the framework jar.

Per-request memoisation is the adapter's call: `makeGetSession` takes whatever dedupe your framework offers (Next's `React.cache`, a `WeakMap` keyed on `event.locals`).

Runtime construction, the `globalThis`-pinned pattern and the RSC seeds stay in the adapter: see [`@awthaq/next`](../next/README.md). Contract: [`spec/behaviors/24-nextjs-ssr.md`](../../spec/behaviors/24-nextjs-ssr.md) (BEH-EA-185/188/189/190/344).
