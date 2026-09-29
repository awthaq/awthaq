# Next.js Server Rendering
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-24 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-185: `getSession` verifies the cookie against the database

```ts
const session = await getSession({ headers: await headers() })   // SessionView | undefined, database-verified
if (!session) redirect("/sign-in")
```

```text
REQUIREMENT: `getSession`, called from a React Server Component or a server
             action, MUST verify the session cookie against the session store,
             not merely check for the cookie's presence; a page or action that
             performs its own authorization MUST NOT rely on cookie presence
             alone for that check.
```

`usage-examples-v4.md` §13 states this directly: "`getSession` reads the cookie and verifies against the database, server-side." Cookie presence is a legitimate optimistic signal for `proxy.ts` (BEH-EA-188), but it is not proof of a valid session — only a database (or equivalently authoritative) lookup is, which is why the two checks are named separately and used in different places.

_Previous: [BEH-EA-184](23-react.md#beh-ea-184-one-evaluation-path-across-server-client-and-tests) | Next: [BEH-EA-186](24-nextjs-ssr.md#beh-ea-186-server-side-decide-produces-the-client-seed)_

## BEH-EA-186: Server-side `decide` produces the client seed

```ts
const entries = yield* Effect.forEach(pairs, ({ resource }) =>
  Effect.all([decide(canDeleteProject, { resource }), decide(canInvite, { resource })]))
return { cards: pairs, decisions: dehydrateDecisions(entries.flat()) }   // plain JSON; no trace by default
```

```text
REQUIREMENT: A page that will render qadi gates MUST decide every policy the
             page needs on the server and pass the result to the client via
             `dehydrateDecisions`; the client MUST NOT re-decide those same
             policies from scratch before the server's answer has hydrated.
```

`usage-qadi.md` §13 shows the pattern: decisions for every gate the page will render are computed once, server-side, in the same pass that loads the resources, and shipped down as plain JSON (no trace by default, keeping the payload small and avoiding leaking evaluation internals to the browser). This is what lets the very first client paint show correct gate states instead of a `pending` spinner for every gate on the page.

_Previous: [BEH-EA-185](24-nextjs-ssr.md#beh-ea-185-getsession-verifies-the-cookie-against-the-database) | Next: [BEH-EA-187](24-nextjs-ssr.md#beh-ea-187-decide-against-attributes-project-content-separately)_

## BEH-EA-187: Decide against attributes; project content separately

```ts
const resources = projects.map(policyResource)   // attributes only, never content
const pairs = readable.filter(/* Allow */).map(({ p, decision }) => ({ resource: policyResource(p), content: project(decision, p) }))
```

```text
REQUIREMENT: The value passed to `decide`/`check` MUST contain only the
             attributes the policy inspects, never the full resource content;
             field-level redaction MUST be applied server-side via
             `project(decision, resource)` before the value is included in the
             page's rendered output.
```

`usage-qadi.md` §16 states the rule generally — "decide against attributes, not content: the resource you evaluate is the resource that crosses to the browser" — and §13's page code follows it exactly: policy evaluation runs against `policyResource(p)` (attributes only), while the actual displayed content is produced by `project(decision, p)`, which trims to granted fields *before* the page ever serializes it. A field a policy withholds is therefore absent from the rendered HTML entirely, not merely hidden by a client component that received it anyway.

_Previous: [BEH-EA-186](24-nextjs-ssr.md#beh-ea-186-server-side-decide-produces-the-client-seed) | Next: [BEH-EA-188](24-nextjs-ssr.md#beh-ea-188-proxyts-is-an-optimistic-redirect-never-the-boundary)_

## BEH-EA-188: `proxy.ts` is an optimistic redirect, never the boundary

```ts
export function proxy(request: NextRequest) {
  if (!hasSessionCookie(request) && request.nextUrl.pathname.startsWith("/app"))
    return NextResponse.redirect(new URL("/sign-in", request.url))
}
```

```text
REQUIREMENT: `proxy.ts` MUST perform only a cookie-presence check for
             redirect purposes; a page or server action reached past `proxy.ts`
             MUST independently verify the session and MUST NOT treat having
             passed `proxy.ts` as proof of authentication or authorization.
```

`usage-examples-v4.md` §13 labels this explicitly: "optimistic redirect only, never the boundary." research/11-client-frontend.md's Q84 gives the platform reason this is not merely a stylistic choice: Next.js's own guidance says Proxy "runs on every route... only read the session from the cookie... and avoid database checks," so a database-backed verification cannot live there without a real performance cost on every request — the real check belongs in the page's data-access layer, where `getSession` (BEH-EA-185) runs it once per request that actually needs it.

_Previous: [BEH-EA-187](24-nextjs-ssr.md#beh-ea-187-decide-against-attributes-project-content-separately) | Next: [BEH-EA-189](24-nextjs-ssr.md#beh-ea-189-withnextcookies-bridges-set-cookie-from-server-actions)_

## BEH-EA-189: `withNextCookies` bridges Set-Cookie from server actions

```ts
"use server"
export async function changeName(form: FormData) {
  return runtime.runPromise(withNextCookies(Users.use((u) => u.rename(String(form.get("name"))))))
}
```

```text
REQUIREMENT: A server action that triggers a `Set-Cookie` (a new session
             issued after a privilege change, a rotated CSRF token) MUST run
             through `withNextCookies` so the header reaches Next's cookie jar;
             it MUST NOT rely on the Effect program's own response object,
             which a server action never sees.
```

`usage-examples-v4.md` §13 shows exactly this shape. React Server Components and the framework layer around server actions don't expose a raw HTTP response for an ordinary Effect program to write `Set-Cookie` onto directly — `withNextCookies` exists specifically to carry that header across the boundary into `next/headers`' cookie API, which is the only thing on the Next.js side actually allowed to write cookies from within a server action.

**Implementation (BO-002).** The shipped surface is `serverActionClient`/`makeServerActionClient` (`@awthaq/next`): an `HttpApiClient` over the application's own composed `api` whose in-process transport dispatches to the application's web handler, forwards the action's `Cookie`/`User-Agent`/`X-Forwarded-For`, echoes the CSRF cookie as `x-csrf-token` (with the bootstrap retry of BEH-EA-170 for a cold action), and passes every response through `withNextCookies` into the action's jar. `withNextCookies` itself stays exported for callers who dispatch on their own.

_Previous: [BEH-EA-188](24-nextjs-ssr.md#beh-ea-188-proxyts-is-an-optimistic-redirect-never-the-boundary) | Next: [BEH-EA-190](24-nextjs-ssr.md#beh-ea-190-server-actions-re-resolve-the-subject-per-invocation)_

## BEH-EA-190: Server actions re-resolve the subject per invocation

```ts
"use server"
export async function deleteProject(id: ProjectId) {
  const session = await getSession({ headers: await headers() })
  return runtime.runPromise(Effect.gen(function*() {
    const subject = yield* SubjectResolver.use((s) => s.resolve(session!.principal))
    /* … */
  }))
}
```

```text
REQUIREMENT: A server action MUST call `getSession` and `SubjectResolver`
             fresh on every invocation; it MUST NOT reuse a subject resolved
             during the page's initial server render for a later action
             invocation.
```

`usage-qadi.md` §13's server-action example resolves the session and subject inline, in the action itself, rather than closing over a value computed when the page rendered — a server action can run long after the page loaded (a user leaving a tab open, then clicking delete), during which a role could have been revoked or a session invalidated; re-resolving on every invocation is what keeps the decision current rather than trusting a snapshot that may have gone stale.

_Previous: [BEH-EA-189](24-nextjs-ssr.md#beh-ea-189-withnextcookies-bridges-set-cookie-from-server-actions) | Next: [BEH-EA-191](24-nextjs-ssr.md#beh-ea-191-one-subject-provided-once-per-page-render)_

## BEH-EA-191: One subject, provided once per page render

```ts
Effect.provide(currentSubjectLayer(subject))
```

```text
REQUIREMENT: A page's server-side data-loading Effect MUST resolve
             `CurrentSubject` exactly once and provide it via
             `currentSubjectLayer` to every `decide`/`filter` call made while
             rendering that page; it MUST NOT re-resolve the subject once per
             policy evaluated.
```

`usage-qadi.md` §13 resolves `subject` a single time at the top of the page's data-loading `Effect.gen` block and provides it once over the whole batch of `decide` calls that follow (read access for every project, then delete/invite decisions for the readable subset). Re-resolving per policy would multiply the resolver round-trips for no behavioral benefit, since the subject cannot legitimately change mid-render of a single request.

_Previous: [BEH-EA-190](24-nextjs-ssr.md#beh-ea-190-server-actions-re-resolve-the-subject-per-invocation) | Next: [BEH-EA-192](24-nextjs-ssr.md#beh-ea-192-hydratedecisions-seeds-the-client-before-first-re-decide)_

## BEH-EA-192: `hydrateDecisions` seeds the client before first re-decide

```ts
const [initialValues] = useState(() => decisions && subject ? Array.from(hydrateDecisions(qadiAtoms, decisions, subject)) : [])
return <QadiProvider atoms={qadiAtoms} subject={subject} initialValues={initialValues}>{children}</QadiProvider>
```

```text
REQUIREMENT: The client MUST seed qadi's atoms from the server's
             `dehydrateDecisions` payload via `hydrateDecisions` before
             `QadiProvider` mounts; a gate for a policy already decided on the
             server MUST NOT render `pending` on first paint merely because
             the client has not yet run its own evaluation.
```

`usage-qadi.md` §12.1 wires this exactly: `hydrateDecisions` reads the server's dehydrated entries and the resolved `subject` to populate the atom store's initial values, so a `Can` gate for a policy the server already decided renders its real verdict immediately. Browser-only attribute resolvers (ones the server evaluated with data the browser cannot independently fetch) stay correctly pending only until the client's own evaluation catches up — the server seed exists precisely to cover that gap, per `usage-qadi.md` §12.1's note that such attributes "stay pending, which is correct."

_Previous: [BEH-EA-191](24-nextjs-ssr.md#beh-ea-191-one-subject-provided-once-per-page-render) | Next: [BEH-EA-193](25-testing-harness.md#beh-ea-193-testauthlayer-is-the-whole-pipeline-over-memory)_
