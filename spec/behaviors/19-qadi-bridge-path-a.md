# Qadi Bridge — Path A (Decide in Handler)
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-19 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a cross-reference to ADR-EA-015 (qadi bridge path selection) (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-145: `AuthorizedSubject` bridges `CurrentPrincipal` to `CurrentSubject`

> **See:** [ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md)

```ts
export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(/* … */)
  .middleware(Authentication)
  .middleware(AuthorizedSubject)   // provides qadi CurrentSubject from CurrentPrincipal
  .middleware(CsrfProtection)
{}
```

```text
REQUIREMENT: The `AuthorizedSubject` middleware MUST require `CurrentPrincipal`
             in its environment and MUST provide qadi's `CurrentSubject` by
             calling `SubjectResolver`; an endpoint group using it MUST list
             `Authentication` before it in the middleware chain.
```

`usage-qadi.md` §3 states this plainly: "`AuthorizedSubject` puts qadi's `CurrentSubject` in the environment of every endpoint in the group." This is the entire Path A bridge — one middleware, placed after `Authentication` so a `Principal` already exists to resolve, that hands every handler in the group qadi's evaluation context without the handler doing any resolution itself.

_Previous: [BEH-EA-144](18-roles-subject-resolver.md#beh-ea-144-the-session-view-exposes-the-resolved-subject) | Next: [BEH-EA-146](19-qadi-bridge-path-a.md#beh-ea-146-one-call-per-need-not-one-call-for-everything)_

## BEH-EA-146: One call per need, not one call for everything

> **See:** [ADR-EA-015](../decisions/015-qadi-bridge-path-selection.md) for guidance on choosing Path A over Path B for a given endpoint.

```ts
| Need                                  | Call                                    |
|----------------------------------------|------------------------------------------|
| yes/no, no obligations                 | `check(policy, { resource })`             |
| the full decision: trace, fields, obligations | `decide(policy, { resource })`      |
| precondition before imperative code    | `assert(policy)`                          |
| gate one effect                        | `enforce(policy)(effect)`                 |
| gate and trim the result to granted fields | `enforceProjected(policy)(effect)`    |
| authorize a collection item by item    | `filter(policy, items)` / `filterStream`  |
| downstream code needs proof            | `guard(permission, policy)(resource, (witness, r) => …)` |
```

```text
REQUIREMENT: A handler MUST choose the qadi call whose shape matches its need
             (single check, full decision, effect gate, projection, collection,
             or unforgeable proof); it MUST NOT layer `check` plus manual
             field-trimming logic where `enforceProjected` already does both.
```

`usage-qadi.md` §3's table is the definitive list; it exists because reimplementing projection or item-by-item filtering on top of a bare `check` call would duplicate logic qadi already provides correctly, and would risk each handler doing the trimming or filtering slightly differently. One canonical call per shape of need is also what keeps `usage-qadi.md` §16's "one evaluation path" rule true in the Path A handlers specifically.

_Previous: [BEH-EA-145](19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject) | Next: [BEH-EA-147](19-qadi-bridge-path-a.md#beh-ea-147-cross-tenant-denial-becomes-404-not-403)_

## BEH-EA-147: Cross-tenant denial becomes 404, not 403

```ts
const hideDenied = (id: ProjectId) => Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id }))
```

```text
REQUIREMENT: A handler reading a tenant-scoped resource by id MUST map
             `AccessDenied` to the resource's own not-found error; it MUST NOT
             let a 403 respond to a request for a resource ID the caller has
             no access to, because a 403 confirms the ID exists.
```

`usage-qadi.md` §3 states the reasoning inline: "Cross-tenant denials become 404. Resolver outages stay 5xx: failure is not denial." A 403 on `GET /projects/:id` tells an attacker the id is valid even though they cannot see it — an enumeration leak identical in kind to the one PRD §18 already closes for `InvalidCredentials`. `ProjectNotFound` gives the caller no more information than "there is nothing here for you," true whether the id never existed or exists in another tenant entirely.

_Previous: [BEH-EA-146](19-qadi-bridge-path-a.md#beh-ea-146-one-call-per-need-not-one-call-for-everything) | Next: [BEH-EA-148](19-qadi-bridge-path-a.md#beh-ea-148-resolver-outages-stay-5xx)_

## BEH-EA-148: Resolver outages stay 5xx

```ts
const outagesAreDefects = Effect.catchTag(
  ["AttributeResolveError", "RelationshipResolveError", "DecisionHistoryUnavailable"],
  Effect.die
)
```

```text
REQUIREMENT: A handler MUST NOT catch a resolver-outage error into
             `AccessDenied` or any other denial; an outage MUST surface as a
             defect (5xx), and a handler MUST NOT `catchAll` across the
             denial/outage boundary.
```

This is qadi's "failure is not denial" house rule (`usage-qadi.md` §16), and the handler pattern in `usage-qadi.md` §3 makes it concrete: `outagesAreDefects` is a *separate* catch from `hideDenied`, deliberately not merged, so a broken `AttributeResolver` cannot be mistaken by a caller — or by an on-call engineer reading logs — for a legitimate access decision. Collapsing the two would make a resolver outage look identical to a correctly-functioning deny, hiding an operational incident behind a security response.

_Previous: [BEH-EA-147](19-qadi-bridge-path-a.md#beh-ea-147-cross-tenant-denial-becomes-404-not-403) | Next: [BEH-EA-149](19-qadi-bridge-path-a.md#beh-ea-149-enforceprojected-trims-the-response-to-granted-fields)_

## BEH-EA-149: `enforceProjected` trims the response to granted fields

```ts
byId: ({ params }) => projects.byId(params.id).pipe(enforceProjected(canReadProject), hideDenied(params.id), outagesAreDefects)
```

```text
REQUIREMENT: `enforceProjected` MUST trim the wrapped effect's success value
             to the fields the policy's decision granted before returning it;
             a handler using it MUST NOT additionally hand-write field
             redaction on the same path.
```

`usage-qadi.md` §3 documents `enforceProjected` as "the wrapped effect's result is trimmed to the fields the policy granted" — a single call replaces what would otherwise be a decide-then-manually-pick-fields pattern repeated in every handler that returns a partially-visible resource, and keeps the redaction logic in exactly one place (qadi's evaluator) rather than reimplemented per endpoint.

_Previous: [BEH-EA-148](19-qadi-bridge-path-a.md#beh-ea-148-resolver-outages-stay-5xx) | Next: [BEH-EA-150](19-qadi-bridge-path-a.md#beh-ea-150-filter-decides-a-collection-item-by-item)_

## BEH-EA-150: `filter` decides a collection item by item

```ts
list: () => projects.all.pipe(Effect.flatMap((all) => filter(canReadProject, all)), outagesAreDefects)
```

```text
REQUIREMENT: A handler returning a list of resources MUST use `filter` (or
             `filterStream` for a stream) to decide each item against the
             policy and drop denied items; it MUST NOT return the full loaded
             collection and rely on the client to hide items it should not see.
```

`usage-qadi.md` §3's table names `filter` for exactly this shape: "one decision per item, denied items dropped." Filtering server-side is what keeps a denied item's data from ever crossing the wire — client-side hiding would still leak the denied resource's existence and content to anything inspecting the response body, defeating the point of the policy.

_Previous: [BEH-EA-149](19-qadi-bridge-path-a.md#beh-ea-149-enforceprojected-trims-the-response-to-granted-fields) | Next: [BEH-EA-151](19-qadi-bridge-path-a.md#beh-ea-151-guard-hands-the-handler-an-unforgeable-witness)_

## BEH-EA-151: `guard` hands the handler an unforgeable witness

```ts
remove: ({ params }) => projects.byId(params.id).pipe(
  Effect.flatMap((p) => guard(project.delete, canDeleteProject)(p, (_witness, resource) => projects.remove(resource.id))),
  hideDenied(params.id), outagesAreDefects
)
```

```text
REQUIREMENT: When downstream code needs proof that a specific permission was
             granted for a specific resource — not merely that some check
             passed somewhere upstream — the handler MUST obtain that proof
             via `guard`'s witness parameter; it MUST NOT thread a boolean or
             re-derive the same conclusion by calling `check` a second time.
```

`usage-qadi.md` §3's table describes `guard` as producing "an `Authorized<typeof project.delete>` witness it cannot forge" — the witness is a value only qadi's evaluator can construct, so a function that requires one as a parameter statically cannot be called except from inside a successful `guard`. This turns "was this authorized?" from a runtime assumption into a type-level guarantee at the one call site (`projects.remove`) that actually performs the destructive action.

_Previous: [BEH-EA-150](19-qadi-bridge-path-a.md#beh-ea-150-filter-decides-a-collection-item-by-item) | Next: [BEH-EA-152](19-qadi-bridge-path-a.md#beh-ea-152-bare-httprouter-routes-use-addguardedroute)_

## BEH-EA-152: Bare `HttpRouter` routes use `addGuardedRoute`

```ts
const ExportRoute = addGuardedRoute("GET", "/projects/:id/export.csv", project.read, canReadProject,
  (request) => Effect.gen(function*() { /* … */ return yield* Projects.use((p) => p.resourceOf(id!)) })
)((_witness, resource) => Projects.use((p) => p.exportCsv(resource.id)).pipe(Effect.map(HttpServerResponse.text)))
// requires SubjectExtractor: provided by SubjectExtractorLive
```

```text
REQUIREMENT: A route registered outside `HttpApi` (a bare `HttpRouter` route)
             that needs authorization MUST use `addGuardedRoute`, which
             requires `SubjectExtractor` and mints the same witness `guard`
             produces; it MUST NOT hand-check `CurrentPrincipal` and skip
             qadi's evaluator for routes outside the typed contract.
```

`usage-qadi.md` §5 shows exactly this: a CSV export route outside the `HttpApi` contract still goes through one evaluation path, because `addGuardedRoute` is built on the same `SubjectExtractor` that Path B's `RequirePermission` uses (file 20) rather than on the request-scoped `CurrentSubject` Path A's `AuthorizedSubject` middleware provides. A contract-shaped route and a bare-router route reach the evaluator by different plumbing, but neither one is allowed to reach it by a second, ad hoc check.

_Previous: [BEH-EA-151](19-qadi-bridge-path-a.md#beh-ea-151-guard-hands-the-handler-an-unforgeable-witness) | Next: [BEH-EA-153](20-qadi-bridge-path-b.md#beh-ea-153-subjectextractor-runs-session-resolution-on-the-raw-request)_
