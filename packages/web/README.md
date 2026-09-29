# @awthaq/web

The framework-neutral core of a web adapter (BO-004). `@awthaq/next` is the Next.js adapter built on it; an Astro or SvelteKit adapter reuses the same pieces and adds only its framework's own glue. Nothing in this package imports a framework.

| Export | What it does |
| --- | --- |
| `getSession(headers, runtime)` | The database-verified boundary (BEH-EA-185): resolves `{ principal, user, session, rotated }`, or `undefined` for a missing, malformed, expired or unknown-session cookie. |
| `makeGetSession(verify)` | The same function over an injected `verify(token, runtime)`, so an adapter can dedupe per render (`@awthaq/next` passes `React.cache(verifySessionToken)`). |
| `applyRotatedSession(session, jar)` | Delivers a rotated session secret into a mutable cookie jar (BO-001). |
| `hasSessionCookie(request)` | The presence-only, proxy/middleware check (BEH-EA-188). Never the boundary. |
| `applyResponseCookies(response, jar)` | Writes every `Set-Cookie` a `Response` carries into a framework cookie jar (BEH-EA-189). |
| `makeInProcessClient(api, options)` / `inProcessClient(api, options)` | A typed `HttpApiClient` over your own composed web handler for server actions: forwards the caller's cookies, echoes `__Host-csrf` as `x-csrf-token`, retries the cold-start CSRF rejection once, and lands every `Set-Cookie` in the jar (BEH-EA-189/190). |
| `@awthaq/web/cookies` | The edge-safe subpath: `findCookieValue`, `hasCookie`, `parseSetCookie`, `applyResponseCookies`, `setCookie` and the jar types, with no `@awthaq/core`/`@awthaq/server` in the import graph. |

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

Per-request memoisation is the adapter's call: `makeGetSession` takes whatever dedupe your framework offers (Next's `React.cache`, a `WeakMap` keyed on `event.locals`).

Runtime construction, the `globalThis`-pinned pattern and the RSC seeds stay in the adapter: see [`@awthaq/next`](../next/README.md). Contract: [`spec/behaviors/24-nextjs-ssr.md`](../../spec/behaviors/24-nextjs-ssr.md) (BEH-EA-185/188/189/190).
