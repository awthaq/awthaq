# @awthaq/next

Next.js adapter: `getSession` (the real, database-verified boundary),
`hasSessionCookie` (the optimistic, `proxy.ts`-only check),
`serverActionClient` (a typed in-process client for server actions),
`withNextCookies` (bridges a `Set-Cookie` produced by awthaq's composed
HTTP router into Next's own cookie jar) and `toInitialSession` /
`toInitialSubject` (RSC-safe seeds for `@awthaq/react`'s `Providers`). See
[`spec/behaviors/24-nextjs-ssr.md`](../../spec/behaviors/24-nextjs-ssr.md)
(BEH-EA-185/188/189) and
[`.scratch/next-package/spec.md`](../../.scratch/next-package/spec.md) for
the full design decisions.

This package deliberately ships no `ManagedRuntime` construction of its
own — every function below takes an explicit runtime (or, for
`withNextCookies`, an already-produced `Response`) as an argument. The
recipe below is the one piece of Next.js-specific plumbing every
application still has to write itself.

## The `globalThis`-pinned runtime

Next's dev server re-evaluates module graphs on every edit. A plain
module-scope `ManagedRuntime.make(AppLayer)` gives you a **second** runtime
on the next edit — a second in-memory store, a second decision cache —
while the first is still referenced by whatever imported it earlier. Effect
v4 ships no `effect/GlobalValue` module (a v3-only API) to paper over this,
so the pattern is written out by hand, pinned to `globalThis`:

```ts
// app/lib/runtime.ts
import "server-only";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { AppLayer } from "./layer.ts"; // your own composed Auth.Built<...>.layer, etc.

declare global {
  // eslint-disable-next-line no-var
  var __appRuntime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined;
}

const make = () => {
  const made = ManagedRuntime.make(AppLayer);
  // `dispose()` closes the Layer scope (pools, finalizers): await it before
  // exiting, but bound it so one stuck finalizer cannot hang shutdown.
  const shutdown = async () => {
    await Promise.race([made.dispose(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    process.exit(0);
  };
  // Registered only here, inside `make()`, so a dev-server hot reload that
  // re-evaluates this module but finds `globalThis.__appRuntime` already set
  // never stacks a second pair of handlers.
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return made;
};

export const runtime = (globalThis.__appRuntime ??= make());
```

Every Server Component, server action, and Route Handler imports this one
`runtime`, never constructs its own. Fibers started with `runtime.runPromise`
are not children of the runtime's scope, so `dispose()` does not wait for
in-flight requests; if you need that, count them yourself (increment before a
`runPromise`, decrement in `finally`) and drain the counter before disposing.

## `proxy.ts`: the optimistic redirect

```ts
// proxy.ts
import { hasSessionCookie } from "@awthaq/next";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (!hasSessionCookie(request) && request.nextUrl.pathname.startsWith("/app")) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
}
```

This file is `proxy.ts` on Next 16.3+; on older versions put the same
function in `middleware.ts` and export it as `middleware`. The recipes in this
README assume Next.js 15 or newer (`headers()`/`cookies()` are async there).

`hasSessionCookie` checks presence only — a forged or expired cookie passes.
This exists purely to skip rendering a page the real boundary below would
reject anyway; it is never itself the boundary.

### A stateless edge check: `@awthaq/next/edge`

Presence lets a forged or long-expired cookie through. If you also run
`@awthaq/jwt`, turn on its opt-in session-mirror cookie —
`JwtConfig.config({ issuer, sessionCookie: true })` — and every
cookie-authenticated response additionally carries a short-lived (default 5
minutes), `__Host-`-prefixed, `HttpOnly`, `SameSite=Strict` JWT copy of the
session. `verifySessionJwt` checks its signature and expiry with no database:

```ts
// proxy.ts
import { makeSessionVerifier, verifySessionJwt } from "@awthaq/next/edge";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const verifier = await makeSessionVerifier({
  jwksUrl: "https://auth.example.com/jwt/jwks",
  issuer: "https://auth.example.com",
  audience: "https://auth.example.com",
  algorithms: ["EdDSA"], // JwtConfig.algorithm
});

export async function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname.startsWith("/app") &&
    (await verifySessionJwt(request, verifier)) === undefined
  ) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
}
```

The mirror rides on authenticated *API* responses, so it exists once the
browser has made one — the first `GET /session` from `@awthaq/react`'s
`Providers` (and every window-focus revalidation) mints and refreshes it; a
server action that signs in can call `client.session.current()` on the same
`serverActionClient` to mint it before redirecting. Where a missing mirror
must not bounce a signed-in user, fall back to `hasSessionCookie`.

Keep the guarantee straight: this is a *better redirect signal*, still not the
boundary. The mirror is a copy — a session revoked server-side keeps verifying
at the edge for at most the cookie's `ttl` (sign-out does not clear it) — and
only `getSession` decides access to anything that matters.

#### Edge deployment

`@awthaq/next/edge` and `hasSessionCookie` are the edge-safe entries: the edge
entry imports only `effect`, the lite verifier and cookie parsing (an import-graph
test pins that it never reaches `@awthaq/core` or `@awthaq/server`), and there are
no separate `edge`/`worker` export conditions — the plain `import` build runs
on WebCrypto runtimes as it is. `getSession`, `serverActionClient` and the seed
helpers need the origin (Sessions, Users, SQL); keep them out of any file your
`proxy.ts` imports. `@awthaq/api` and `@awthaq/client` are runtime-neutral.

## The real boundary: `getSession`

```ts
// app/projects/page.tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@awthaq/next";
import { runtime } from "../lib/runtime.ts";

// A page derived from the session must be dynamic. `headers()` already makes a
// route dynamic implicitly; the explicit export survives refactors and partial
// prerendering. Never cache a shell that contains session data.
export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession(await headers(), runtime);
  if (session === undefined) redirect("/sign-in");
  // session.principal, session.user, session.session are all resolved and
  // database-verified here — resolve a qadi subject from session.principal
  // yourself via `@qadi/core`'s `SubjectResolver.resolve` if you need one.
  return <ProjectList userId={session.user.id} />;
}
```

## Seeding `@awthaq/react`'s `Providers` from a Server Component

`getSession`'s `Session` is a server-only shape, and `Providers`' seed types are
`Schema.Class` instances — neither can be a Client Component prop (React only
serializes plain data). `toInitialSession` / `toInitialSubject` produce the
encoded plain-JSON shape `Providers` accepts as `initialSession` /
`initialSubject`; it decodes and validates them on the client, so a malformed
seed is ignored (and reported through `onError`), never trusted.

```tsx
// app/layout.tsx  (a Server Component)
import { headers } from "next/headers";
import { getSession, toInitialSession, toInitialSubject } from "@awthaq/next";
import { runtime } from "./lib/runtime.ts";
import { resolveSubject } from "./lib/qadi.ts"; // your own SubjectResolver.resolve(principal), run on the runtime
import { ClientProviders } from "./client-providers.tsx";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession(await headers(), runtime);
  const subject = session === undefined ? undefined : await resolveSubject(session.principal);
  return (
    <html>
      <body>
        <ClientProviders
          initialSession={toInitialSession(session)}
          initialSubject={toInitialSubject(subject)}
        >
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
```

`ClientProviders` is a `"use client"` module of yours that renders
`<Providers atoms={atoms} ...>` from `@awthaq/react` (your qadi `atoms` are
built on the client, so they cannot be passed as props). Seeds apply once, at
first mount: `router.refresh()` does not re-seed a mounted `Providers`.
`@awthaq/next` stays off `@awthaq/qadi`, which is why the subject comes from your
own resolver.

### Server-decided gates on first paint

To have a `<Can>` render its verdict on the very first paint (BEH-EA-186/192)
decide it on the server and hand the dehydrated result to `Providers`. Hydration
is app-level wiring from `@qadi/react`'s exports — this package adds nothing:

```ts
// in the Server Component that already resolved `subject`:
import { dehydrateDecisions } from "@qadi/react";
const decisions = dehydrateDecisions([{ policy: canEditPost, resource, decision }]);
// ... <ClientProviders decisions={decisions} ...>  (forward to <Providers decisions={decisions}>)
```

`decisions` is bound to a subject id: `Providers` hydrates it against the seeded
subject only, and drops a payload for anyone else (or one with no seeded
session) — the gate then re-decides on the client exactly as it would without
hydration.

## Server actions: a typed in-process client

`serverActionClient(api, { handler, headers, jar })` is an `HttpApiClient` over
your own composed `api` whose transport calls your own web handler in-process
— so `client.password.signIn(...)` is typed for whichever plugin set you
composed, and the action's cookies and client metadata ride along:

```ts
// app/lib/handler.ts — built once, next to the pinned runtime
import "server-only";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { AppRoutesLayer } from "./layer.ts"; // AuthHttp.routes(AppApi, ...) plus your services

declare global {
  // eslint-disable-next-line no-var
  var __appHandler: ReturnType<typeof HttpRouter.toWebHandler> | undefined;
}

export const { handler } = (globalThis.__appHandler ??= HttpRouter.toWebHandler(AppRoutesLayer));
```

```ts
// app/actions.ts
"use server";
import { cookies, headers } from "next/headers";
import { serverActionClient } from "@awthaq/next";
import { AppApi } from "./lib/api.ts";
import { handler } from "./lib/handler.ts";

export async function signIn(email: string, password: string) {
  const client = await serverActionClient(AppApi, {
    handler,
    headers: await headers(),
    jar: await cookies(),
    mode: "result", // resolve a typed Result<A, E> instead of rejecting
  });
  const result = await client.password.signIn({ payload: { email, password } });
  return result._tag === "Success" ? "ok" : result.failure._tag; // e.g. "InvalidCredentials"
}
```

What it does for you:

- forwards the action's `Cookie`, `User-Agent` and `X-Forwarded-For` to the
  handler (not `Origin`/`Sec-Fetch-Site`: with neither present the CSRF site
  check has nothing to reject on, and the double-submit check still runs);
- echoes the `__Host-csrf` cookie as `x-csrf-token`, and — for a cold action
  with no CSRF cookie yet — retries the rejected call once with the fresh
  cookie the 403 minted, so the first mutation succeeds;
- writes every `Set-Cookie` the handler produced into Next's jar
  (`withNextCookies`), so the browser gets the session cookie.

Without `mode`, methods reject with the endpoint's tagged contract error. The
Effect-native form is `makeServerActionClient(api, options)`; an api whose
groups need client middleware beyond CSRF's must use it and provide that layer
(the Promise form refuses to compile rather than silently skip it). Build one
client per action invocation — it carries that request's cookie state. This
package still constructs no runtime: the `handler` is yours.

`withNextCookies(response, jar)` stays exported for callers who dispatch
themselves: it only harvests a `Set-Cookie` that awthaq's own
`HttpApiBuilder.securitySetCookie` calls already produce (sign-in, sign-up,
CSRF rotation) — it takes a `Response` and a cookie jar, nothing more.

## Session rotation and `applyRotatedSession`

`Sessions.verify` may rotate the session's secret on a throttled idle touch
(at most once per `SessionConfig.touchEvery`, 1 hour by default) — the old
secret stops verifying the moment that happens, no grace window.
`getSession`'s `Session` carries that fresh token on `session.rotated`
(`undefined` when nothing rotated this call); deliver it in any context that
holds a mutable cookie jar — a Server Action or a Route Handler:

```ts
// app/actions.ts
"use server";
import { cookies, headers } from "next/headers";
import { getSession, applyRotatedSession } from "@awthaq/next";
import { runtime } from "./lib/runtime.ts";

export async function doSomething() {
  const session = await getSession(await headers(), runtime);
  applyRotatedSession(session, await cookies());
  // ...
}
```

A pure Server Component render has no mutable cookie jar at all — Next.js
RSCs cannot set cookies under any circumstances — so a rotation that happens
to land during a Server-Component-only render is a genuine platform
limitation, not something this package can route around. In practice this
only matters for an app that routes essentially zero traffic through Server
Actions/Route Handlers for an entire `touchEvery` window; the overwhelming
common case (any interactive app with real mutating traffic) delivers
rotation reliably the moment it happens. An app that is intentionally
close to 100% static RSC rendering can raise `touchEvery` in its own
`SessionConfig` to make this residual window rarer.

`getSession` itself memoizes per request/render via `React.cache()`, so two
calls against the same cookie within one render or one Server Action
invocation hit `Sessions.verify` exactly once — this also closes the
version of this bug where a second, un-memoized call could lose the
rotation race mid-render.
