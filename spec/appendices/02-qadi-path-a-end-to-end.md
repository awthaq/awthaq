# Qadi Path A, End to End
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-APP-02 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Appendix — Worked Example |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added inline BEH-EA citations per section and an ADR-EA-009 citation, beyond the header-only citation this appendix previously had (CCR-EA-002) |
---

Every code block in this appendix is reproduced here as an uncompiled
illustration; nothing in this repository compiles yet, so every fence below
is `ts` regardless of the fence language used in the source material. This
differs from qadi's own appendices, which are gate-compiled — effect-auth has
no such tooling yet (see [`../process/definitions-of-done.md`](../process/definitions-of-done.md)
gate 8). This walkthrough reproduces material from `archive/design/usage-qadi.md`
§§1–3 and 7–10 as a single narrative; it exercises
[BEH-EA-137–144 Roles and the Subject Resolver](../behaviors/18-roles-subject-resolver.md),
[BEH-EA-145–152 Qadi Bridge — Path A](../behaviors/19-qadi-bridge-path-a.md), and
[BEH-EA-161–168 Qadi Resolvers and Obligations](../behaviors/21-qadi-resolvers-obligations.md). The
decision this whole walkthrough rests on is
[ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md#adr-ea-009-authorization-is-delegated-to-qadi).

The division of labor between the two libraries is one line: **effect-auth
answers who is asking; qadi answers what they may do and what they may see.**
The bridge between them is a single service, `SubjectResolver`, which turns a
`Principal` — effect-auth's answer to "who" — into qadi's `AuthSubject`, the
input to every policy qadi evaluates.

## 1. Wiring qadi once

*(Exercises [BEH-EA-137](../behaviors/18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only) and [BEH-EA-145](../behaviors/19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject).)

A team that has already composed `Password` and wants roles and
organizations installs `Organization` and `Roles` alongside it. `Roles`
overrides the `SubjectResolver` slot — that is a compile-time exclusive
contribution, so installing a second plugin that also tries to override
`SubjectResolver` is a compile error at `Auth.make`, not a runtime surprise.

```ts
// app/auth.ts
import { Auth, Sessions, Users } from "@effect-auth/core"
import { Password } from "@effect-auth/password"
import { Organization } from "@effect-auth/organization"
import { Roles } from "@effect-auth/roles"
import { AuthorizedSubjectLive, SubjectExtractorLive } from "@effect-auth/qadi"
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

What subject a request resolves to depends entirely on the kind of principal
effect-auth handed it:

| Principal | `AuthSubject` |
|---|---|
| `User` with roles plugin | `id: "user:<id>"`, `roles` from the role table, `permissions` flattened through the role DAG, `attributes.actingAs` when impersonating |
| `User` without roles plugin | `id` only. Every policy that needs a role or permission denies. |
| `ApiKey` | `id: "apikey:<keyId>"`, `permissions` = the key's scopes |
| `Service` | `id: "service:<name>"`, `permissions` = its scopes |
| no credential | qadi's `anonymous` |

That table is the whole contract: nothing about roles, permissions, or
organizations is defined by effect-auth itself. `Roles` merely fills in
`AuthSubject.roles` and `.permissions`; the vocabulary those fields draw from
is qadi's, defined next.

## 2. Defining the permission and role vocabulary once

The application's permission groups, roles, and policies are ordinary qadi
values, defined at module scope — never inline in a handler, because qadi's
atom family keys structurally, and a fresh policy object built inline in
render would re-walk its whole tree every time to arrive at the atom it was
always going to find anyway.

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
    hasRelationship("member", { depth: 2 })                 // via the organization plugin's resolver
  ])
]))

export const canDeleteProject = allOf([
  hasPermission(project.delete),
  hasResourceAttribute("ownerId", eq(subjectId())),
  not(hasAttribute("actingAs", exists()))                   // an impersonating admin may look, not delete
])

export const canManageBilling = allOf([
  hasPermission(billing.manage),
  hasAttribute("plan", inArray(["team", "enterprise"]))     // attribute resolved from effect-auth's user table
])
```

`canReadProject` is worth reading closely, because it is the shape most
policies in this appendix take: a permission check (`hasPermission`, with the
fields it grants visibility into), combined with an `anyOf` over the ways a
subject can legitimately reach the resource — public visibility, ownership,
or organization membership resolved through a relationship graph. The
membership branch is what §7 below builds on.

## 3. Path A: deciding in the handler

With the vocabulary defined, `AuthorizedSubject` middleware puts qadi's
`CurrentSubject` into the environment of every endpoint in a group, and
handlers pick whichever enforcement call fits the shape of what they are
doing.

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

Two decisions in that handler set are deliberate and worth naming: a denied
decision on a cross-tenant resource is mapped to `404 ProjectNotFound` rather
than `403`, so a caller probing IDs cannot distinguish "exists, not yours"
from "does not exist"; and a resolver *outage* — the attribute or
relationship resolver failing, not denying — is explicitly routed to
`Effect.die` rather than treated as a denial, because a failure to answer the
question is not the same claim as answering it with "no."

Five enforcement calls appear above and below; which one fits depends on the
shape of the operation:

| Need | Call |
|---|---|
| yes/no, no obligations | `check(policy, { resource })` |
| the full decision: trace, visible fields, obligations | `decide(policy, { resource })` |
| precondition before imperative code | `assert(policy)` |
| gate one effect | `enforce(policy)(effect)` |
| gate and trim the result to granted fields | `enforceProjected(policy)(effect)` |
| authorize a collection item by item | `filter(policy, items)`, `filterStream` for streams |
| downstream code needs proof | `guard(permission, policy)(resource, (witness, r) => …)` |

## 4. An organization-scoped policy

`canReadProject`'s membership branch above is not hypothetical — here is the
policy an "invite a teammate" endpoint actually enforces, scoped by
organization and by a plan limit that lives on the resource itself rather
than on the subject:

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

The organization plugin ships its own relationship resolver
(`Organization.relationships`) so that an application installs membership-aware
policies with one line rather than writing a resolver from scratch.

## 5. An obligation: step-up authentication

Not every `Allow` is unconditional. A sensitive operation like changing the
account email can be permitted in principle but still carry an obligation —
here, that the session be recently re-authenticated — which an enforcing call
refuses to proceed past until it is discharged.

```ts
import { obliged, obligation } from "@qadi/core"

export const reauth = obligation("effect-auth/reauth", { maxAgeSeconds: 300 })
export const canChangeEmail = obliged(reauth, hasPermission(permission("account", "update")))

// effect-auth ships the handler: allowed only if the session was authenticated within maxAgeSeconds
import { ObligationHandlers } from "@effect-auth/qadi"

changeEmail: ({ payload }) =>
  Users.use((u) => u.changeEmail(payload.email)).pipe(
    enforce(canChangeEmail, { onObligations: ObligationHandlers.reauth }),   // fails ReauthenticationRequired (401) when stale
  )
```

`ObligationHandlers.reauth` is effect-auth's contribution, not qadi's: it
reads the session off `CurrentPrincipal`, compares `authenticatedAt` to the
obligation's `maxAgeSeconds`, and fails with a typed error the client maps to
a "confirm your password" screen. `client.session.reauthenticate` is the
client-side counterpart — it refreshes `authenticatedAt` without issuing an
entirely new session.

## 6. Pushing the policy into SQL

Loading every row and filtering in application code does not scale to a
large list. `canReadProject`'s attribute half can instead be compiled to a
SQL predicate and pushed into the query itself:

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

This is only a partial answer for `canReadProject`, though, because
`hasRelationship` nodes cannot be rendered to SQL — `compileSql` fails with
`PredicateNotRenderable` rather than silently approximating a graph traversal
as a `WHERE` clause. The correct split is to push the attribute part into
SQL and run the relationship part through `filter` in application code
afterward, rather than trying to force one mechanism to answer both halves
of the policy.

## 7. Auditing every decision

*(Exercises [BEH-EA-161](../behaviors/21-qadi-resolvers-obligations.md#beh-ea-161-attributes-resolved-from-the-user-table) and [BEH-EA-164](../behaviors/21-qadi-resolvers-obligations.md#beh-ea-164-decision-history-backed-by-audit-events).)

Every decision qadi makes can be observed without changing it. A ring buffer
for recent-decision inspection, a live feed for devtools, and a durable audit
sink can all subscribe to the same stream:

```ts
import { decisionSinkAll, decisionSinkRing, decisionSinkFeed } from "@qadi/core"
import { AuditDecisionSinkLive } from "@qadi/audit"

const ring = decisionSinkRing({ environment: "Server", capacity: 500 })
const feed = Effect.runSync(decisionSinkFeed({ capacity: 256, replay: 32 }))

export const Sinks = decisionSinkAll([
  ring.layer,                                                         // recent decisions, for /backlog
  feed.layer,                                                         // live stream, for devtools
  AuditDecisionSinkLive({ failureThreshold: 5 }).pipe(Layer.provide(AuthAuditTrail.layer))   // durable: effect-auth's audit table implements AuditTrailPort
])

// devtools stream, guarded, re-checking the subject every 30 seconds
import { decisionStreamRoute } from "@qadi/http"
decisionStreamRoute(adminAccess, hasRole("admin"), feed.stream, { reauth: { every: "30 seconds" } })
```

`AuthAuditTrail` is effect-auth's own audit table implementing qadi's
`AuditTrailPort` — the durable sink is effect-auth data, wired through qadi's
generic sink interface. Crucially, a sink can never change a decision it
observes: if the durable audit trail breaks, its circuit breaker trips and
the failure is logged, but the request in flight still gets the answer the
policy computed. Auditability never becomes an availability dependency for
authorization itself.

That closes the loop this appendix set out to walk: one wiring step that
turns effect-auth principals into qadi subjects, a vocabulary of permissions
and roles defined once, five ways to enforce a policy in a handler, an
organization-scoped policy backed by a relationship resolver the
organization plugin ships, an obligation effect-auth discharges from session
freshness, a policy pushed into SQL where it can be, and every decision
observed without any observer able to change the answer.
