# Next.js SSR with Decision Hydration
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-APP-03 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Appendix — Worked Example |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added inline BEH-EA citations per section and ADR-EA-003/009 citations, beyond the header-only citation this appendix previously had (CCR-EA-002) |
---

Every code block in this appendix is reproduced here as an uncompiled
illustration; nothing in this repository compiles yet, so every fence below
is `ts` even though the source material renders these examples as `tsx`.
This differs from qadi's own appendices, which are gate-compiled — effect-auth
has no such tooling yet (see [`../process/definitions-of-done.md`](../process/definitions-of-done.md)
gate 8). This walkthrough combines `archive/design/usage-examples-v4.md` §13
and `archive/design/usage-qadi.md` §13 into a single narrative; it exercises
[BEH-EA-185–192 Next.js Server Rendering](../behaviors/24-nextjs-ssr.md)
and [BEH-EA-177–184 React Bindings](../behaviors/23-react.md). The bridge this
depends on is [ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md#adr-ea-009-authorization-is-delegated-to-qadi),
and the isomorphic contract it reads through is
[ADR-EA-003](../decisions/003-httpapi-as-contract.md#adr-ea-003-httpapi-is-the-api-contract).

The problem this appendix solves is specific: a Next.js app wants to decide
authorization *on the server*, where the subject's roles, attributes, and the
resource data all already live, and then hand the *browser* only the answer
— never the reasoning, never the data a denied decision would have exposed.

## 1. Deciding on the server, against attributes, not content

*(Exercises [BEH-EA-185](../behaviors/24-nextjs-ssr.md#beh-ea-185-getsession-verifies-the-cookie-against-the-database) and [BEH-EA-186](../behaviors/24-nextjs-ssr.md#beh-ea-186-server-side-decide-produces-the-client-seed).)

A React Server Component resolves the session from the incoming request,
resolves a qadi subject from that session's principal, and then decides
every policy the page will need up front — before any of it is sent to the
client.

```ts
// app/projects/page.tsx — React Server Component
import { headers } from "next/headers"
import { currentSubjectLayer, decide, project } from "@qadi/core"
import { dehydrateDecisions } from "@qadi/react"
import { getSession } from "@effect-auth/next"

export const dynamic = "force-dynamic"

export default async function Page() {
  const session = await getSession({ headers: await headers() })
  if (!session) redirect("/sign-in")

  const { cards, decisions } = await runtime.runPromise(
    Effect.gen(function*() {
      const subject = yield* SubjectResolver.use((s) => s.resolve(session.principal))
      // decide read access once per project; project() trims content to the granted fields on the server
      const readable = yield* Effect.forEach(yield* Projects.all, (p) =>
        Effect.map(decide(canReadProject, { resource: policyResource(p) }), (decision) => ({ p, decision })))
      const pairs = readable
        .filter(({ decision }) => decision._tag === "Allow")
        .map(({ p, decision }) => ({ resource: policyResource(p), content: project(decision, p) }))
      // name the other questions the page will render, decide them in one pass
      const entries = yield* Effect.forEach(pairs, ({ resource }) =>
        Effect.all([decide(canDeleteProject, { resource }), decide(canInvite, { resource })]).pipe(
          Effect.map(([d1, d2]) => [{ policy: canDeleteProject, resource, decision: d1 }, { policy: canInvite, resource, decision: d2 }])))
      return { cards: pairs, decisions: dehydrateDecisions(entries.flat()) }   // plain JSON; no trace by default
    }).pipe(Effect.provide(currentSubjectLayer(subject)))
  )

  return (
    <Providers initialSession={session} decisions={decisions}>
      {cards.map((c) => <ProjectCard key={c.resource.id} {...c} />)}
    </Providers>
  )
}
```

Two rules govern everything in that component, and they are the reason this
whole appendix exists rather than being folded into ordinary data fetching:

1. **Decide against attributes, never against content.** `policyResource(p)`
   extracts only the fields a policy is allowed to look at — visibility,
   owner, membership — never the project's body. Whatever a decision is
   made *against* is implicitly information the decision's presence in the
   dehydrated payload can leak; deciding against content would mean a denied
   decision still reveals what it was denied over.
2. **Project content on the server, before it crosses the wire.**
   `project(decision, article)` trims the resource itself to the fields the
   granted decision actually allows. A field the reader may not see is
   *absent from the HTML*, not merely hidden by client-side conditional
   rendering — which matters because conditional rendering still ships the
   data in the RSC payload for anyone who reads it.

`dehydrateDecisions` is what turns a set of qadi `Decision` values into the
plain JSON that can safely cross into a client component: an allow/deny
verdict, granted fields, and any obligation — with no trace attached by
default, since a trace is itself diagnostic detail no browser needs.

## 2. Seeding the client via the provider

*(Exercises [BEH-EA-177](../behaviors/23-react.md#beh-ea-177-registryprovider-seeds-the-session-atom-for-ssr).)

The dehydrated decisions and the session both flow into `<Providers>`, which
wraps `QadiProvider` (and effect-auth's own session provider) so that client
components can call `useDecision` / `useCan` against a policy and get back
exactly the answer the server already computed — no second round trip, and
no re-decision against data the client was never given.

```ts
// components/providers.tsx (sketch)
"use client"
import { QadiProvider } from "@qadi/react"

export function Providers({ initialSession, decisions, children }) {
  return (
    <SessionProvider initialSession={initialSession}>
      <QadiProvider hydratedDecisions={decisions}>
        {children}
      </QadiProvider>
    </SessionProvider>
  )
}
```

A client component under this provider that calls `useDecision(canDeleteProject,
{ resource })` for a resource the server already decided gets the hydrated
answer synchronously; it never re-runs the policy against attributes the
browser does not have.

## 3. The `proxy.ts` caveat: optimistic only, never the boundary

*(Exercises [BEH-EA-188](../behaviors/24-nextjs-ssr.md#beh-ea-188-proxyts-is-an-optimistic-redirect-never-the-boundary).)

Next.js middleware (in this appendix's naming, `proxy.ts`) can check for the
mere *presence* of a session cookie and redirect unauthenticated visitors
away from an app shell before a page even renders. That is a UX optimization
— it saves a round trip to a page that would only redirect anyway — and it
must never be mistaken for the authorization boundary itself:

```ts
// proxy.ts — optimistic redirect only, never the boundary
import { hasSessionCookie } from "@effect-auth/next"
export function proxy(request: NextRequest) {
  if (!hasSessionCookie(request) && request.nextUrl.pathname.startsWith("/app")) return NextResponse.redirect(new URL("/sign-in", request.url))
}
```

`hasSessionCookie` checks for a cookie's presence, not its validity — it does
not verify the session against the database, does not resolve a principal,
and does not run any qadi policy. A forged or expired cookie passes this
check. The real boundary is the server-side `getSession` call inside the
page itself (§1) and every `decide`/`enforce`/`guard` call downstream of it;
`proxy.ts` exists only to avoid rendering a page that the real boundary would
reject anyway, and removing it would change nothing about what is actually
protected.

## 4. A server action that bridges cookies

Mutations from client components go through server actions, which resolve
the session and the subject exactly as the page did, and then enforce the
same policy the page decided against — `guard` here means the action's body
only runs once qadi has granted `project.delete` against this exact
resource, and the caller gets an unforgeable witness as proof.

```ts
// a server action, same subject resolution
"use server"
export async function deleteProject(id: ProjectId) {
  const session = await getSession({ headers: await headers() })
  return runtime.runPromise(
    Effect.gen(function*() {
      const subject = yield* SubjectResolver.use((s) => s.resolve(session!.principal))
      const resource = yield* Projects.use((p) => p.resourceOf(id))
      return yield* guard(project.delete, canDeleteProject)(resource, () => Projects.use((p) => p.remove(id))).pipe(Effect.provide(currentSubjectLayer(subject)))
    })
  )
}
```

Because a server action runs in its own request, it re-resolves the session
and subject from scratch rather than trusting anything the client sent back
— the hydrated decision the browser holds was correct at render time, but a
mutation always re-decides against the current state, since a decision that
old could have been invalidated by something that happened in between.

There is a second, more mechanical bridging concern in server actions that
is easy to miss: effect-auth operations that set cookies — a session
refresh, a sign-out, a rename that touches `Set-Cookie` — need those
headers routed into Next's own cookie jar rather than lost. That is what a
helper like `withNextCookies` is for:

```ts
// server action
"use server"
import { withNextCookies } from "@effect-auth/next"
export async function changeName(form: FormData) {
  return runtime.runPromise(withNextCookies(Users.use((u) => u.rename(String(form.get("name"))))))   // Set-Cookie from Effect reaches Next's jar
}
```

Put together, this is the whole SSR story: decide on the server against
attributes only, project content down to granted fields before it ever
reaches the client, hydrate the browser with verdicts rather than reasoning,
treat `proxy.ts` as pure UX rather than a security boundary, and have every
server action re-resolve the subject and re-decide rather than trust
anything the client already believes.
