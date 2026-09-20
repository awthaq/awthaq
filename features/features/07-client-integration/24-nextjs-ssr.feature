# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@client-integration @nextjs-ssr
@skip @unwired
Feature: Next.js Server Rendering

  # BEH-EA-185 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-185
  Rule: getSession verifies the cookie against the database

    @REQ-EA-522
    Scenario: getSession returns a database-verified SessionView for a valid cookie
      Given a valid session cookie for "alice" that matches a live session row
      When a React Server Component calls "getSession({ headers: await headers() })"
      Then it returns a database-verified "SessionView" for "alice"

    @REQ-EA-523
    Scenario: A present but invalid session cookie is rejected, not accepted on presence alone
      Given a session cookie that is present but does not match any live session row
      When a server action calls "getSession({ headers: await headers() })"
      Then it returns "undefined"
      And the page or action does not rely on the cookie's mere presence to treat the caller as authenticated

    @REQ-EA-524
    Scenario: Cookie presence alone is a signal only for proxy.ts, never a substitute for getSession's verification
      Given a request carrying a session cookie
      When a page or server action performs its own authorization
      Then it calls "getSession" to verify the cookie against the session store
      And it never treats cookie presence alone as sufficient for that authorization check

  # BEH-EA-186 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-186
  Rule: Server-side decide produces the client seed

    @REQ-EA-525
    Scenario: Every policy a page renders gates for is decided once, server-side
      Given qadi's evaluator would return decisions for "canDeleteProject" and "canInvite" against each of the page's resources
      When the page's server-side data-loading Effect runs
      Then all of those decisions are computed once during that server render
      And the results are passed to the client via "dehydrateDecisions"

    @REQ-EA-526
    Scenario: dehydrateDecisions produces plain JSON with no trace by default
      Given the decisions computed during a page's server render
      When they are passed through "dehydrateDecisions"
      Then the resulting payload is plain JSON
      And it carries no evaluation trace by default

    @REQ-EA-527
    Scenario: The client does not re-decide the server's policies from scratch before hydration completes
      Given a page whose gates were already decided server-side and dehydrated
      When the client renders those gates before "hydrateDecisions" has hydrated the atom store
      Then the client does not re-decide those same policies from scratch
      And the first client paint shows the correct gate states rather than a pending spinner for every gate

  # BEH-EA-187 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-187
  Rule: Decide against attributes; project content separately

    @REQ-EA-528
    Scenario: The value passed to decide contains only the attributes the policy inspects
      Given a project resource with both policy-relevant attributes and additional content fields
      When "decide(canReadProject, { resource: policyResource(project) })" is called
      Then the value passed to "decide" contains only the attributes the policy inspects
      And it does not contain the resource's full content

    @REQ-EA-529
    Scenario: project(decision, resource) trims a resource to its granted fields before serialization
      Given a decision that grants only a subset of "project"'s fields
      When the page produces its rendered output via "project(decision, project)"
      Then the returned value contains only the fields the decision grants
      And this trimming happens before the page's output is serialized

    @REQ-EA-530
    Scenario: A field withheld by the policy is absent from the rendered HTML entirely
      Given a field of "project" that the decision does not grant
      When the page renders its output using "project(decision, project)"
      Then that field is absent from the server-rendered HTML entirely
      And it is not merely hidden by a client component that received it anyway

  # BEH-EA-188 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-188
  Rule: proxy.ts is an optimistic redirect, never the boundary

    @REQ-EA-531
    Scenario: proxy.ts redirects to sign-in based solely on cookie presence
      Given a request to a path under "/app" carrying no session cookie
      When "proxy.ts" runs against that request
      Then it redirects to "/sign-in"
      And it performs no database check to reach that decision

    @REQ-EA-532
    Scenario: A present but stale session cookie passes proxy.ts yet is rejected by the page's own check
      Given a request to a path under "/app" carrying a session cookie that is present but stale
      When "proxy.ts" runs against that request
      Then the request is allowed past "proxy.ts" on the strength of the cookie's presence
      But the page's own "getSession" call independently rejects the stale session

    @REQ-EA-533
    Scenario: A page or server action does not treat having passed proxy.ts as proof of authentication
      Given a request that has passed "proxy.ts"'s cookie-presence check
      When the page or server action reached past "proxy.ts" runs
      Then it independently verifies the session itself
      And it does not treat having passed "proxy.ts" as proof of authentication or authorization

  # BEH-EA-189 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-189
  Rule: withNextCookies bridges Set-Cookie from server actions

    @REQ-EA-534
    Scenario Outline: A server action that triggers Set-Cookie runs through withNextCookies to reach Next's cookie jar
      Given a server action that results in "<trigger>"
      When the action runs "runtime.runPromise(withNextCookies(...))"
      Then the resulting "Set-Cookie" header reaches Next's cookie jar via "next/headers"

      Examples:
        | trigger                                          |
        | a new session issued after a privilege change    |
        | a rotated CSRF token                             |

    @REQ-EA-535
    Scenario: The server action does not rely on the Effect program's own response object
      Given a server action whose Effect program would ordinarily write "Set-Cookie" onto its own response object
      When the action runs inside a Next.js server action
      Then it does not rely on that response object, because a server action never sees it
      And it instead relies on "withNextCookies" to carry the header across the boundary

  # BEH-EA-190 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-190
  Rule: Server actions re-resolve the subject per invocation

    @REQ-EA-536
    Scenario: A server action calls getSession and SubjectResolver fresh on each invocation
      Given a server action "deleteProject"
      When it is invoked
      Then it calls "getSession({ headers: await headers() })" and "SubjectResolver.use((s) => s.resolve(session.principal))" fresh, within that invocation

    @REQ-EA-537
    Scenario: A role revoked after the page's initial render is reflected on the next action invocation
      Given a page rendered while "alice" held a role granting "deleteProject"
      And "alice"'s role is revoked after the page rendered, while her tab remains open
      When "alice" later triggers the "deleteProject" server action from that same open tab
      Then the action re-resolves "alice"'s subject fresh and reflects the revoked role
      And it does not reuse the subject resolved during the page's initial server render

    @REQ-EA-538
    Scenario: A server action does not reuse a subject resolved during the page's initial render
      Given a subject resolved once during a page's initial server render
      When a server action on that page is invoked afterward
      Then the action resolves its own subject fresh
      And it does not reuse the subject resolved during the page's initial render

  # BEH-EA-191 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-191
  Rule: One subject, provided once per page render

    @REQ-EA-539
    Scenario: CurrentSubject is resolved exactly once at the top of a page's data-loading Effect
      Given a page's server-side data-loading "Effect.gen" block
      When the block begins
      Then it resolves "CurrentSubject" exactly once

    @REQ-EA-540
    Scenario: The single resolved subject is provided to every decide and filter call for that page render
      Given the subject resolved once at the top of a page's data-loading Effect
      When the page evaluates read access for every project, then delete and invite decisions for the readable subset
      Then all of those "decide"/"filter" calls are provided the same subject via "currentSubjectLayer"

    @REQ-EA-541
    Scenario: Rendering a page that evaluates many policies still performs exactly one subject resolution
      Given a page that evaluates policies for "N" resources during one render
      When that page render completes
      Then exactly one subject resolution occurred
      And the subject was not re-resolved once per policy evaluated

  # BEH-EA-192 — spec/behaviors/24-nextjs-ssr.md
  @BEH-EA-192
  Rule: hydrateDecisions seeds the client before first re-decide

    @REQ-EA-542
    Scenario: hydrateDecisions seeds qadi's atoms from the server's dehydrated payload before QadiProvider mounts
      Given a server-dehydrated "decisions" payload and the resolved "subject" for the current user
      When the client computes "hydrateDecisions(qadiAtoms, decisions, subject)" and passes the result as "QadiProvider"'s "initialValues"
      Then the atoms are seeded from that payload before "QadiProvider" mounts

    @REQ-EA-543
    Scenario: A gate for a policy already decided server-side renders its real verdict immediately
      Given a policy the server already decided during page render, included in the dehydrated "decisions" payload
      When the client renders the "Can" gate for that policy on first paint
      Then it renders the server's real verdict immediately
      And it does not render "pending" merely because the client has not yet run its own evaluation

    @REQ-EA-544
    Scenario: A gate depending on a browser-only attribute resolver correctly stays pending after hydration
      Given a policy whose attribute resolver can only run in the browser and was not evaluated server-side
      When the client hydrates decisions via "hydrateDecisions" and renders the gate for that policy
      Then the gate correctly stays "pending" until the client's own evaluation completes
