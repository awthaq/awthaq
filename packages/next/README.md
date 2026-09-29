# @awthaq/next

Next.js adapter: `getSession` (the real, database-verified boundary),
`hasSessionCookie` (the optimistic, `proxy.ts`-only check), and
`withNextCookies` (bridges a `Set-Cookie` produced by awthaq's composed
HTTP router into Next's own cookie jar). See
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
  const dispose = () => void made.dispose();
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  return made;
};

export const runtime = (globalThis.__appRuntime ??= make());
```

Every Server Component, server action, and Route Handler imports this one
`runtime`, never constructs its own.

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

`hasSessionCookie` checks presence only — a forged or expired cookie passes.
This exists purely to skip rendering a page the real boundary below would
reject anyway; it is never itself the boundary.

## The real boundary: `getSession`

```ts
// app/projects/page.tsx
import { headers } from "next/headers";
import { getSession } from "@awthaq/next";
import { runtime } from "../lib/runtime.ts";

export default async function Page() {
  const session = await getSession(await headers(), runtime);
  if (session === undefined) redirect("/sign-in");
  // session.principal, session.user, session.session are all resolved and
  // database-verified here — resolve a qadi subject from session.principal
  // yourself via `@qadi/core`'s `SubjectResolver.resolve` if you need one.
  return <ProjectList userId={session.user.id} />;
}
```

## A server action that bridges cookies

```ts
// app/actions.ts
"use server";
import { cookies } from "next/headers";
import { withNextCookies } from "@awthaq/next";
import { runtime } from "./lib/runtime.ts";
import { AppApi } from "./lib/api.ts"; // your own composed HttpApi/router

export async function signIn(email: string, password: string) {
  const request = new Request("http://internal/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json" },
  });
  const { handler } = await runtime.runPromise(/* build your web handler from AppApi */);
  const response = await handler(request);
  withNextCookies(response, await cookies());
  return response.ok;
}
```

`withNextCookies` only ever harvests a `Set-Cookie` that awthaq's own
`HttpApiBuilder.securitySetCookie` calls already produce (sign-in, sign-up,
CSRF rotation) — it takes a `Response` and a cookie jar, nothing more, so it
composes with however your app already dispatches requests against its own
composed router.

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
