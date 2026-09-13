# Awthaq + qadi — Usage Examples

Version 0.3 — 2026-09-12. Companion to `design/plugins-as-layers.md`. Every qadi call below is checked against `../qadi` (0.4.0): `@qadi/core`, `@qadi/http`, `@qadi/react`, `@qadi/testing`, `@qadi/predicate-sql`, `@qadi/audit`, `@qadi/promise`.

The division of labour in one line: **awthaq answers who is asking; qadi answers what they may do and what they may see.** The bridge between them is one service, `SubjectResolver`, which turns a `Principal` into qadi's `AuthSubject`.

---

## 1. Wire it once

```ts
// app/auth.ts
import { Auth, Sessions, Users } from "@awthaq/core"
import { Password } from "@awthaq/password"
import { Organization } from "@awthaq/organization"
import { Roles } from "@awthaq/roles"
import { AuthorizedSubjectLive, SubjectExtractorLive } from "@awthaq/qadi"
import { EvaluationIdLive, EvaluationServicesNone, decisionCacheLayer } from "@qadi/core"
import { PermissionRegistryLive, RequirePermissionLive } from "@qadi/http"

export const auth = Auth.make([Password, Organization, Roles])
//  Roles overrides the SubjectResolver slot: subjects now carry roles and flattened permissions.
//  Installing a second plugin that overrides SubjectResolver is a compile error at Auth.make.

// qadi's own services. EvaluationServicesNone = every optional port's fail-closed default.
export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))

// The two bridges: one for handlers (path A), one for annotated endpoints (path B).
export const AuthzLive = Layer.mergeAll(
  AuthorizedSubjectLive,                                   // CurrentPrincipal → CurrentSubject, as HttpApi middleware
  RequirePermissionLive.pipe(Layer.provide(SubjectExtractorLive))   // raw request → AuthSubject, for qadi's middleware
).pipe(Layer.provide(auth.layer))
```

The subject a request gets, by principal kind:

| Principal | `AuthSubject` |
|---|---|
| `User` with roles plugin | `id: "user:<id>"`, `roles` from the role table, `permissions` flattened through the role DAG, `attributes.actingAs` when impersonating |
| `User` without roles plugin | `id` only. Every policy that needs a role or permission denies. |
| `ApiKey` | `id: "apikey:<keyId>"`, `permissions` = the key's scopes |
| `Service` | `id: "service:<name>"`, `permissions` = its scopes |
| no credential | qadi's `anonymous` |

---

## 2. Define the vocabulary once

```ts
// app/domain/authz.ts
import {
  allOf, anyOf, not, createPermissionGroup, permission, role,
  hasPermission, hasRole, hasAttribute, hasResourceAttribute, hasRelationship,
  eq, inArray, subjectId, resource, exists, labeled
} from "@qadi/core"

export const project = createPermissionGroup("project", ["read", "update", "delete", "invite"] as const)
export const billing = createPermissionGroup("billing", ["read", "manage"] as const)
export const adminAccess = permission("admin", "access")

export const member = role({ name: "member", permissions: [project.read] })
export const editor = role({ name: "editor", permissions: [project.update, project.invite], inherits: [member] })
export const owner  = role({ name: "owner",  permissions: [project.delete, billing.manage], inherits: [editor] })
export const admin  = role({ name: "admin",  permissions: [adminAccess], inherits: [owner] })

export const canReadProject = labeled("read project", allOf([
  hasPermission(project.read, { fields: ["id", "name", "summary", "visibility", "ownerId"] }),
  anyOf([
    hasResourceAttribute("visibility", eq(literal("public"))),
    hasResourceAttribute("ownerId", eq(subjectId())),
    hasRelationship("member", { depth: 2 })                 // via the organization plugin's resolver, §6
  ])
]))

export const canDeleteProject = allOf([
  hasPermission(project.delete),
  hasResourceAttribute("ownerId", eq(subjectId())),
  not(hasAttribute("actingAs", exists()))                   // an impersonating admin may look, not delete
])

export const canManageBilling = allOf([
  hasPermission(billing.manage),
  hasAttribute("plan", inArray(["team", "enterprise"]))     // attribute resolved from awthaq's user table, §6
])
```

Module scope, never inline: qadi's atom family keys structurally, and the decision cache keys on the policy.

---

## 3. Path A — decide in the handler

`AuthorizedSubject` puts qadi's `CurrentSubject` in the environment of every endpoint in the group. Handlers then use the enforcement call that fits.

```ts
// app/api/projects.ts — contract
export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(ProjectView) }),
    HttpApiEndpoint.get("byId", "/:id", { params: { id: ProjectId }, success: ProjectView, error: ProjectNotFound }),
    HttpApiEndpoint.patch("update", "/:id", { params: { id: ProjectId }, payload: Project.jsonUpdate, success: ProjectView, error: ProjectNotFound }),
    HttpApiEndpoint.post("remove", "/:id/delete", { params: { id: ProjectId }, success: HttpApiSchema.NoContent, error: ProjectNotFound })
  )
  .middleware(Authentication)
  .middleware(AuthorizedSubject)
  .middleware(CsrfProtection)
  .prefix("/projects")
{}
```

```ts
// app/api/projects.handlers.ts
import { assert, enforce, enforceProjected, filter, guard } from "@qadi/core"

export const ProjectsHandlers = HttpApiBuilder.group(AppApi, "projects", Effect.fn(function*(handlers) {
  const projects = yield* Projects

  // Cross-tenant denials become 404. Resolver outages stay 5xx: failure is not denial.
  const hideDenied = (id: ProjectId) => Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id }))
  const outagesAreDefects = Effect.catchTag(["AttributeResolveError", "RelationshipResolveError", "DecisionHistoryUnavailable"], Effect.die)

  return handlers.handleAll({
    // filter: one decision per item, denied items dropped
    list: () => projects.all.pipe(Effect.flatMap((all) => filter(canReadProject, all)), outagesAreDefects),

    // enforceProjected: the wrapped effect's result is trimmed to the fields the policy granted
    byId: ({ params }) => projects.byId(params.id).pipe(enforceProjected(canReadProject), hideDenied(params.id), outagesAreDefects),

    // enforce: run the effect only if allowed; the resource is the loaded row
    update: ({ params, payload }) => Effect.gen(function*() {
      const current = yield* projects.byId(params.id)
      return yield* projects.update(params.id, payload).pipe(enforce(hasPermission(project.update), { resource: current }))
    }).pipe(hideDenied(params.id), outagesAreDefects),

    // guard: the handler receives an Authorized<typeof project.delete> witness it cannot forge
    remove: ({ params }) => projects.byId(params.id).pipe(
      Effect.flatMap((p) => guard(project.delete, canDeleteProject)(p, (_witness, resource) => projects.remove(resource.id))),
      hideDenied(params.id), outagesAreDefects
    )
  })
}))
```

Which call, when:

| Need | Call |
|---|---|
| yes/no, no obligations | `check(policy, { resource })` |
| the full decision: trace, visible fields, obligations | `decide(policy, { resource })` |
| precondition before imperative code | `assert(policy)` |
| gate one effect | `enforce(policy)(effect)` |
| gate and trim the result to granted fields | `enforceProjected(policy)(effect)` |
| authorize a collection item by item | `filter(policy, items)`, `filterStream` for streams |
| downstream code needs proof | `guard(permission, policy)(resource, (witness, r) => …)` |

---

## 4. Path B — declare the permission on the endpoint

qadi's `RequirePermission` reads an annotation and refuses endpoints that declare nothing. Use it for resource-less gates and for anything that should appear in the permission registry.

```ts
import { PublicEndpoint, publicEndpoint, RequiredPermission, RequirePermission, requiresPermission } from "@qadi/http"

export class AdminApi extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("stats", "/stats", { success: Stats }).pipe((e) =>
      e.annotate(RequiredPermission, requiresPermission(e, { permission: adminAccess, policy: hasRole("admin") }))),
    HttpApiEndpoint.post("reindex", "/reindex", { success: HttpApiSchema.Accepted }).pipe((e) =>
      e.annotate(RequiredPermission, requiresPermission(e, { permission: adminAccess, policy: allOf([hasRole("admin"), not(hasAttribute("actingAs", exists()))]) }))),
    HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }).pipe((e) =>
      e.annotate(PublicEndpoint, publicEndpoint("liveness probe, no subject exists yet")))
  )
  .middleware(RequirePermission)
  .prefix("/admin")
{}
// An endpoint in this group with neither annotation answers 500 and logs its name. Absence is refusal.
```

Status mapping is qadi's: `AccessDenied` and `UndischargedObligation` → 403; resolver outages → 502; wiring mistakes → 500. Bodies are empty; the trace is in the span.

### The permission registry

```ts
import { registerApi, permissionRegistryRoute } from "@qadi/http"

const Routes = Layer.mergeAll(
  AuthHttp.routes(auth.api),
  HttpApiBuilder.layer(AppApi).pipe(Layer.provide([ProjectsHandlers, AdminHandlers])),
  registerApi(AppApi),                                             // reads every RequiredPermission annotation
  permissionRegistryRoute(adminAccess, hasRole("admin"))          // GET /__permissions, behind that policy
).pipe(Layer.provide(AuthzLive), Layer.provide(QadiLive), Layer.provide(auth.layer), Layer.provideMerge(PermissionRegistryLive))
```

```
GET /__permissions   (as admin)
[{ "permission": "admin:access", "endpoints": [{ "method": "GET", "path": "/admin/stats", "group": "admin" }, …] }, …]
```

---

## 5. Bare `HttpRouter` routes

For routes outside `HttpApi`, `addGuardedRoute` mints the witness and registers the path.

```ts
import { addGuardedRoute } from "@qadi/http"

const ExportRoute = addGuardedRoute(
  "GET", "/projects/:id/export.csv",
  project.read, canReadProject,
  (request) => Effect.gen(function*() {
    const { id } = yield* HttpRouter.params
    return yield* Projects.use((p) => p.resourceOf(id!))          // attributes the policy reads, not the content
  })
)((_witness, resource) => Projects.use((p) => p.exportCsv(resource.id)).pipe(Effect.map(HttpServerResponse.text)))
// requires SubjectExtractor: provided by SubjectExtractorLive
```

---

## 6. Resolvers backed by awthaq data

qadi asks three questions it cannot answer itself. Each is a service; each default denies.

### 6.1 Attributes from the user table

```ts
import { AttributeResolver } from "@qadi/core"

export const UserAttributes = Layer.effect(AttributeResolver, Effect.gen(function*() {
  const users = yield* Users
  return AttributeResolver.of({
    name: "awthaq/UserAttributes",
    resolve: (subjectId, attribute) => {
      const [type, id] = subjectId.split(":")
      if (type !== "user") return Effect.succeed(undefined)
      return users.byId(id as UserId).pipe(
        Effect.map((u) => attribute === "plan" ? u.plan : attribute === "emailVerified" ? u.emailVerifiedAt !== undefined : undefined),
        Effect.mapError((cause) => new AttributeResolveError({ subjectId, attribute, cause }))   // outage ≠ denial
      )
    }
  })
}))
// policy: hasAttribute("emailVerified", eq(literal(true)))
```

Static attributes belong on the subject (`SubjectResolver` puts `actingAs` there). Revocable ones must go through the resolver, otherwise a browser holding the subject never learns they changed.

### 6.2 Relationships from the organization plugin

```ts
import { RelationshipResolver } from "@qadi/core"

export const OrgRelationships = Layer.effect(RelationshipResolver, Effect.gen(function*() {
  const org = yield* Organization
  return RelationshipResolver.of({
    name: "awthaq/OrgRelationships",
    check: ({ subjectId, relation, resourceId, depth }) => Effect.gen(function*() {
      const [type, userId] = subjectId.split(":")
      if (type !== "user") return "Unrelated" as const
      // "member" of a project = member of the project's organization; depth 2 walks project → org
      const orgId = yield* Projects.use((p) => p.organizationOf(resourceId as ProjectId))
      const isMember = yield* org.isMember(orgId, userId as UserId)
      return isMember ? "Related" as const : "Unrelated" as const
    }).pipe(Effect.mapError((cause) => new RelationshipResolveError({ subjectId, relation, resourceId, cause })))
  })
}))
// policy: hasRelationship("member", { depth: 2 })
```

For fixed graphs, `relationshipResolverFromEdges([{ subjectId, relation, resourceId }])` is enough.

### 6.3 Decision history from auth events

```ts
import { DecisionHistory } from "@qadi/core"

export const TermsHistory = Layer.effect(DecisionHistory, Effect.gen(function*() {
  const audit = yield* AuditLog                            // fed by AuthEvents.on(…) subscriptions
  return DecisionHistory.of({
    hasActed: ({ subjectId, event }) => audit.exists(subjectId, event).pipe(Effect.map((b) => b ? "Acted" as const : "NotActed" as const),
      Effect.mapError((cause) => new DecisionHistoryUnavailable({ cause })))
  })
}))
// policy: hasActed("accepted-terms")   — gate the whole API until terms are accepted
```

Wire them in place of the fail-closed defaults:

```ts
export const QadiLive = Layer.mergeAll(
  UserAttributes, OrgRelationships, TermsHistory,
  CustomPredicateNone, SignatureHistoryNone,               // still the defaults
  EvaluationIdLive, decisionCacheLayer({ capacity: 512 })
).pipe(Layer.provide(auth.layer))
```

---

## 7. Organization-scoped policies

```ts
export const canInvite = allOf([
  hasPermission(project.invite),
  hasRelationship("member", { depth: 2 }),
  hasResourceAttribute("membershipCount", lt(literal(100)))   // plan limit lives on the resource attributes
])

// the resource the policy sees: attributes only, computed once per request
export const inviteResource = (orgId: OrganizationId) => Effect.gen(function*() {
  const org = yield* Organization
  return { id: orgId, membershipCount: yield* org.memberCount(orgId) }
})

// handler
invite: ({ params, payload }) => inviteResource(params.orgId).pipe(
  Effect.flatMap((r) => guard(project.invite, canInvite)(r, () => Organization.use((o) => o.invite(params.orgId, payload)))),
  Effect.catchTag("AccessDenied", () => new OrganizationNotFound({ id: params.orgId }))
)
```

The organization plugin ships `Organization.relationships` (the resolver in §6.2) so an app installs it with one line instead of writing it.

---

## 8. Obligations: step-up authentication

An `Allow` may carry an obligation. Enforcing calls refuse to proceed until it is discharged. awthaq discharges the re-authentication obligation from session freshness.

```ts
import { obliged, obligation } from "@qadi/core"

export const reauth = obligation("awthaq/reauth", { maxAgeSeconds: 300 })
export const canChangeEmail = obliged(reauth, hasPermission(permission("account", "update")))

// awthaq ships the handler: allowed only if the session was authenticated within maxAgeSeconds
import { ObligationHandlers } from "@awthaq/qadi"

changeEmail: ({ payload }) =>
  Users.use((u) => u.changeEmail(payload.email)).pipe(
    enforce(canChangeEmail, { onObligations: ObligationHandlers.reauth }),   // fails ReauthenticationRequired (401) when stale
  )
```

`ObligationHandlers.reauth` reads `CurrentPrincipal`'s session, compares `authenticatedAt` to the obligation's `maxAgeSeconds`, and fails with a typed error the client maps to a "confirm your password" screen; `client.session.reauthenticate` refreshes `authenticatedAt` without issuing a new session.

---

## 9. Push the policy into SQL

For lists, evaluate in the database instead of loading and filtering.

```ts
import { toPredicate } from "@qadi/core"
import { compileSql } from "@qadi/predicate-sql"

const listProjects = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const predicate = yield* toPredicate(canReadProject)                       // reads CurrentSubject; folds roles and attributes
  const where = yield* compileSql(predicate, { dialect: "postgres" })         // { text: "(visibility = $1 OR owner_id = $2 …)", params: [...] }
  return yield* sql<Project>`SELECT * FROM project WHERE ${sql.unsafe(where.text, where.params)} ORDER BY created_at DESC LIMIT 50`
})
```

`hasRelationship` nodes cannot be rendered to SQL; `compileSql` fails with `PredicateNotRenderable` rather than approximating. Split such policies: SQL for the attribute part, `filter` for the relationship part.

---

## 10. Audit every decision

```ts
import { decisionSinkAll, decisionSinkRing, decisionSinkFeed } from "@qadi/core"
import { AuditDecisionSinkLive } from "@qadi/audit"

const ring = decisionSinkRing({ environment: "Server", capacity: 500 })
const feed = Effect.runSync(decisionSinkFeed({ capacity: 256, replay: 32 }))

export const Sinks = decisionSinkAll([
  ring.layer,                                                         // recent decisions, for /backlog
  feed.layer,                                                         // live stream, for devtools
  AuditDecisionSinkLive({ failureThreshold: 5 }).pipe(Layer.provide(AuthAuditTrail.layer))   // durable: awthaq's audit table implements AuditTrailPort
])

// devtools stream, guarded, re-checking the subject every 30 seconds
import { decisionStreamRoute } from "@qadi/http"
decisionStreamRoute(adminAccess, hasRole("admin"), feed.stream, { reauth: { every: "30 seconds" } })
```

A sink cannot change a decision; a broken audit trail trips the breaker and logs, and the request still gets its answer.

---

## 11. Impersonation, seen by policies

```ts
// awthaq puts the impersonator on the subject; policies branch on it
export const readOnlyWhileImpersonating = rules([
  denyWhen(allOf([hasAttribute("actingAs", exists()), hasAction("write")])),
  permitWhen(hasPermission(project.update))
], { combining: "DenyOverrides" })

// evaluate with the action supplied
yield* enforce(readOnlyWhileImpersonating, { action: "write", resource })(update)
```

---

## 12. React

### 12.1 Providers: the session atom feeds `QadiProvider`

```tsx
"use client"
import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/unstable/reactivity"
import { EvaluationIdLive, EvaluationServicesNone, makeSubject } from "@qadi/core"
import { QadiProvider, hydrateDecisions, makeQadiAtoms } from "@qadi/react"
import { sessionAtom } from "./auth"

// Browser-side evaluation services. Attributes the browser cannot know stay pending, which is correct;
// the server seed (§13) covers them until the client's own answer arrives.
const qadiAtoms = makeQadiAtoms(Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive))

const toSubject = (v: SessionView | undefined) =>
  v && makeSubject({ id: v.subject.id, roles: v.subject.roles, permissions: v.subject.permissions as never, attributes: v.subject.attributes })

export const Providers = ({ initialSession, decisions, children }: ProvidersProps) => (
  <RegistryProvider initialValues={[[sessionAtom, AsyncResult.success(initialSession)]]}>
    <Authz decisions={decisions}>{children}</Authz>
  </RegistryProvider>
)

const Authz = ({ decisions, children }: { decisions?: DehydratedDecisions; children: React.ReactNode }) => {
  const session = useAtomValue(sessionAtom)
  const subject = toSubject(AsyncResult.isSuccess(session) ? session.value : undefined)
  const [initialValues] = useState(() => decisions && subject ? Array.from(hydrateDecisions(qadiAtoms, decisions, subject)) : [])
  return <QadiProvider atoms={qadiAtoms} subject={subject} initialValues={initialValues}>{children}</QadiProvider>
}
```

### 12.2 Gates and hooks

```tsx
import { Can, Cannot, useCan, useDecision, usePolicies, useProjected, useSubject } from "@qadi/react"

export const ProjectCard = ({ resource, content }: { resource: ProjectResource; content: ProjectContent }) => {
  const view = useProjected(canReadProject, resource)                 // only the fields the policy grants
  const { del, invite } = usePolicies({ del: canDeleteProject, invite: canInvite })   // one evaluation per policy, shared across components
  return (
    <article>
      <h3>{view.name}</h3>
      <p>{content.summary}</p>
      <Can policy={canDeleteProject} resource={resource} pending={<Spinner />} fallback={(deny) => <Why reason={deny.reason} />}>
        <DeleteButton id={resource.id} />
      </Can>
      <Cannot policy={canManageBilling}><UpgradeNudge /></Cannot>
    </article>
  )
}

export const AdminLink = () => (useCan(hasRole("admin")) ? <a href="/admin">Admin</a> : null)
```

A decision being re-checked renders `pending`, never the previous verdict. Sign-out sets `subject` to `undefined` and every gate closes at once.

### 12.3 After a mutation that changes grants

```tsx
import { useInvalidate } from "@qadi/react"

const AcceptInvite = ({ token }: { token: string }) => {
  const [result, run] = useAtom(acceptInvite)
  const invalidate = useInvalidate()
  return <button onClick={() => run({ params: { token: Redacted.make(token) }, reactivityKeys: ["session"] }).then(invalidate)}>Accept</button>
  // the session refetch updates roles; invalidate() re-decides every mounted gate against the new subject
}
```

---

## 13. Next.js: decide on the server, seed the browser

```tsx
// app/projects/page.tsx — React Server Component
import { headers } from "next/headers"
import { currentSubjectLayer, decide, project } from "@qadi/core"
import { dehydrateDecisions } from "@qadi/react"
import { getSession } from "@awthaq/next"

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

Two rules that page follows: decide against **attributes**, never against content, because whatever you decide against crosses to the client; and project content on the server with `project(decision, article)` so a field the reader may not see is absent from the HTML, not hidden.

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

---

## 14. Non-Effect code

```ts
import { makeQadi } from "@qadi/promise"

const qadi = makeQadi(QadiLive)                   // the same Layer as the server
const subject = await runtime.runPromise(SubjectResolver.use((s) => s.resolve(principal)))
if (await qadi.check(subject, canReadProject, { resource })) { /* … */ }
```

---

## 15. Testing

```ts
import { assert, it } from "@effect/vitest"
import { check, currentSubjectLayer, decide, renderTrace } from "@qadi/core"
import { qadiTestLayer, subjectWith, recordingAttributeResolver, edgeRelationshipResolver } from "@qadi/testing"

it.effect("only the owner may delete", () => Effect.gen(function*() {
  const resource = { id: "p1", ownerId: "user:u1" }
  const asOwner = check(canDeleteProject, { resource }).pipe(Effect.provide(qadiTestLayer(subjectWith({ id: "user:u1", permissions: ["project:delete"] }))))
  const asOther = check(canDeleteProject, { resource }).pipe(Effect.provide(qadiTestLayer(subjectWith({ id: "user:u2", permissions: ["project:delete"] }))))
  assert.isTrue(yield* asOwner)
  assert.isFalse(yield* asOther)
}))

it.effect("membership grants read through the relationship", () => Effect.gen(function*() {
  const decision = yield* decide(canReadProject, { resource: { id: "p1", ownerId: "user:u9", visibility: "private" } })
  assert.strictEqual(decision._tag, "Allow")
  yield* Effect.log(renderTrace(decision.trace))          // the node that granted it, by label
}).pipe(Effect.provide(qadiTestLayer(subjectWith({ id: "user:u1", permissions: ["project:read"] }), {
  relationships: edgeRelationshipResolver([{ subjectId: "user:u1", relation: "member", resourceId: "p1" }])
}))))

// through HTTP, with awthaq's test layer and qadi's middleware
const makeClient = HttpApiTest.groups(AppApi, ["admin"])
layer(Layer.mergeAll(TestAuth.layer([Password, Roles]), AuthzLive, QadiLive, HttpServer.layerServices))("admin", (it) => {
  it.effect("stats needs the admin role", () => Effect.gen(function*() {
    const client = yield* makeClient
    yield* TestAuth.signInAs({ email: "ops@acme.com", roles: ["member"] })
    const err = yield* client.admin.stats().pipe(Effect.flip)
    assert.strictEqual(err._tag, "Forbidden")           // 403 from RequirePermission
  }))
})
```

---

## 16. Rules that keep the two libraries honest

- **Failure is not denial.** A broken resolver is 502, never 403. Do not `catchAll` into `AccessDenied`.
- **Absence is refusal.** Under `RequirePermission`, an unannotated endpoint is a 500 with a log, not an open door.
- **Decide against attributes, not content.** The resource you evaluate is the resource that crosses to the browser.
- **A stale decision is not a decision.** Read verdicts through `Can`, `useCan` or `currentDecision`; never through the raw async result.
- **Static on the subject, revocable through a resolver.** `actingAs` and roles ride on the subject; plan and verification status come from `AttributeResolver`.
- **One evaluation path.** `RequirePermission`, `guard`, `enforce`, the React gates and the Promise facade all call the same evaluator. Do not write a second check.
