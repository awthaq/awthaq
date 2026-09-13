# Qadi Bridge — Path B (Declared Permissions)
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-20 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a cross-reference to ADR-EA-015, clarified that `SubjectExtractor` reuses `Authentication`'s session-verification logic rather than reimplementing it, and added the INV-EA-013 callout to BEH-EA-156 (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; effect-auth is pre-implementation.

## BEH-EA-153: `SubjectExtractor` runs session resolution on the raw request

> **See:** [ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md)

```ts
const AuthzLive = Layer.mergeAll(
  AuthorizedSubjectLive,
  RequirePermissionLive.pipe(Layer.provide(SubjectExtractorLive))
).pipe(Layer.provide(auth.layer))
```

```text
REQUIREMENT: `SubjectExtractor` MUST perform effect-auth's own session
             resolution directly against the raw HTTP request, independent of
             `Authentication`'s middleware pipeline, so that qadi's
             `RequirePermission` middleware can run before any effect-auth
             contract middleware executes.
```

Path B's `RequirePermission` is qadi's middleware, not effect-auth's, so it cannot depend on `CurrentPrincipal` the way `AuthorizedSubject` does in Path A — `SubjectExtractor` is the adapter that lets qadi read a subject straight from the request. `usage-qadi.md` §1 wires it exactly this way: `RequirePermissionLive.pipe(Layer.provide(SubjectExtractorLive))`, a self-contained bridge qadi's middleware can be given without effect-auth's contract middleware needing to run first.

`SubjectExtractor` performing session resolution "directly against the raw HTTP request, independent of `Authentication`'s middleware pipeline" describes *where in the request lifecycle* it runs, not a second implementation of session verification: it MUST reuse the identical hash-comparison and absolute/idle-expiry logic `Authentication`'s own middleware uses over `Sessions` — the same path [BEH-EA-066](09-authentication-middleware.md#beh-ea-066-the-bearer-handler-is-tried-after-the-cookie-handler-fails-over-the-same-session-resolution-logic) already requires the bearer handler to share with the cookie handler, and the same constant-time-compare/expiry mechanics [BEH-EA-050](07-sessions.md#beh-ea-050-only-sha-256secret-is-persisted-the-plaintext-secret-is-never-stored), [BEH-EA-051](07-sessions.md#beh-ea-051-a-session-carries-independent-absolute-and-idle-expiries-idle-refresh-never-extends-the-absolute-deadline), and [BEH-EA-056](07-sessions.md#beh-ea-056-session-secret-verification-is-a-constant-time-comparison-over-a-fixed-length-hash) specify. A `SubjectExtractor` implementation that hand-wrote its own hash comparison or its own expiry check — even one that produced the same answer in the common case — would be exactly the hand-written duplication of contract logic [BEH-EA-169](22-client-effect.md#beh-ea-169-the-client-derives-from-the-merged-contract) forbids: two independent places a session-validity bug could be fixed in only one, leaving effect-auth with two sources of truth for what "a valid session" means depending on which of Path A or Path B a given request happened to go through.

_Previous: [BEH-EA-152](19-qadi-bridge-path-a.md#beh-ea-152-bare-httprouter-routes-use-addguardedroute) | Next: [BEH-EA-154](20-qadi-bridge-path-b.md#beh-ea-154-requirepermission-reads-the-requiredpermission-annotation)_

## BEH-EA-154: `RequirePermission` reads the `RequiredPermission` annotation

```ts
HttpApiEndpoint.get("stats", "/stats", { success: Stats }).pipe((e) =>
  e.annotate(RequiredPermission, requiresPermission(e, { permission: adminAccess, policy: hasRole("admin") })))
```

```text
REQUIREMENT: An endpoint gated by `RequirePermission` MUST declare its
             permission and policy via the `RequiredPermission` annotation
             using `requiresPermission`; the middleware MUST evaluate exactly
             that declared policy and no other.
```

`usage-qadi.md` §4 and `usage-examples-v4.md` §10.4 show the identical shape: the annotation lives on the endpoint definition itself, so the permission a route requires is visible by reading the contract, not by reading the handler body — which is also what makes the permission registry (BEH-EA-158) possible without executing anything.

_Previous: [BEH-EA-153](20-qadi-bridge-path-b.md#beh-ea-153-subjectextractor-runs-session-resolution-on-the-raw-request) | Next: [BEH-EA-155](20-qadi-bridge-path-b.md#beh-ea-155-publicendpoint-is-the-only-other-legal-annotation)_

## BEH-EA-155: `PublicEndpoint` is the only other legal annotation

```ts
HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }).pipe((e) =>
  e.annotate(PublicEndpoint, publicEndpoint("liveness probe, no subject exists yet")))
```

```text
REQUIREMENT: An endpoint in a group middlewared by `RequirePermission` MUST
             carry either `RequiredPermission` or `PublicEndpoint`; declaring
             `PublicEndpoint` MUST require a documented reason string, not a
             bare boolean.
```

`PublicEndpoint` exists for routes that genuinely have no subject to evaluate against — a liveness probe, in `usage-qadi.md` §4's example — and requiring a reason string keeps that exemption self-documenting in the same place the permission requirement would otherwise live, so a reviewer reading the contract sees *why* an endpoint is public, not just that it is.

_Previous: [BEH-EA-154](20-qadi-bridge-path-b.md#beh-ea-154-requirepermission-reads-the-requiredpermission-annotation) | Next: [BEH-EA-156](20-qadi-bridge-path-b.md#beh-ea-156-absence-of-either-annotation-is-refusal-not-an-open-door)_

## BEH-EA-156: Absence of either annotation is refusal, not an open door

> **Invariant:** [INV-EA-013](../invariants.md#inv-ea-013-an-endpoint-under-qadis-declared-permission-path-with-neither-a-permission-nor-a-public-endpoint-annotation-is-refused-never-silently-allowed)

```text
// An endpoint in this group with neither annotation answers 500 and logs its name. Absence is refusal.
```

```text
REQUIREMENT: An endpoint middlewared by `RequirePermission` that declares
             neither `RequiredPermission` nor `PublicEndpoint` MUST fail every
             request to it with a 500 and MUST log the endpoint's name; it
             MUST NOT be reachable as an unguarded 200.
```

This is qadi's "absence is refusal" house rule (`usage-qadi.md` §16) at its most concrete: an endpoint an author forgot to annotate is a wiring mistake, not an implicit grant, and the failure mode effect-auth exposes for that mistake is loud (500 plus a log naming the endpoint) specifically so it is caught in development or in the contract-test suite (file 25), never discovered in production as an accidental open door.

_Previous: [BEH-EA-155](20-qadi-bridge-path-b.md#beh-ea-155-publicendpoint-is-the-only-other-legal-annotation) | Next: [BEH-EA-157](20-qadi-bridge-path-b.md#beh-ea-157-status-mapping-is-qadis-not-effect-auths)_

## BEH-EA-157: Status mapping is qadi's, not effect-auth's

```text
AccessDenied, UndischargedObligation → 403
resolver outage → 502
wiring mistake (missing annotation) → 500
```

```text
REQUIREMENT: `RequirePermission` MUST map `AccessDenied` and
             `UndischargedObligation` to 403, a resolver outage to 502, and a
             missing annotation to 500; effect-auth MUST NOT reinterpret or
             override this mapping in its own bridge code.
```

`usage-qadi.md` §4 states this mapping directly, and it is qadi's own status taxonomy, not something effect-auth layers on top: 403 is a decision, 502 is qadi's evaluation infrastructure being unreachable (still "failure is not denial," expressed here as a gateway error rather than a handler defect since Path B has no handler code to `Effect.die` from), and 500 is the operator's own contract mistake. Bodies are empty on all three; the trace lives in the span, not in a response an attacker could read.

_Previous: [BEH-EA-156](20-qadi-bridge-path-b.md#beh-ea-156-absence-of-either-annotation-is-refusal-not-an-open-door) | Next: [BEH-EA-158](20-qadi-bridge-path-b.md#beh-ea-158-the-permission-registry-route)_

## BEH-EA-158: The permission registry route

```ts
const Routes = Layer.mergeAll(
  registerApi(AppApi),                                       // reads every RequiredPermission annotation
  permissionRegistryRoute(adminAccess, hasRole("admin"))      // GET /__permissions, behind that policy
)
```

```text
REQUIREMENT: `registerApi` MUST derive the permission registry purely from
             `RequiredPermission` annotations already present on the contract,
             without executing any handler; `permissionRegistryRoute` MUST
             itself be guarded by a policy, never served unauthenticated.
```

`usage-qadi.md` §4 shows the output shape (`GET /__permissions` returning `[{ "permission": "admin:access", "endpoints": [...] }, ...]`) and the fact that it is registered "behind that policy" — the registry is operationally valuable precisely because it is static (readable without running the application, matching the CLI's own "reads the manifest, never runs the application" posture in file 26) and because the list of who-can-do-what is itself sensitive enough to need its own access control.

_Previous: [BEH-EA-157](20-qadi-bridge-path-b.md#beh-ea-157-status-mapping-is-qadis-not-effect-auths) | Next: [BEH-EA-159](20-qadi-bridge-path-b.md#beh-ea-159-choosing-path-b-over-path-a)_

## BEH-EA-159: Choosing Path B over Path A

> **See:** [ADR-EA-015](../decisions/015-qadi-bridge-path-selection.md)

```text
REQUIREMENT: An endpoint that gates on subject state alone (no loaded
             resource to evaluate against) SHOULD use Path B; an endpoint
             whose decision depends on a loaded resource's attributes MUST use
             Path A, because Path B has no resource to hand the policy.
```

`usage-qadi.md` §4 frames Path B as being for "resource-less gates and for anything that should appear in the permission registry" — `AdminApi.stats` needs only `hasRole("admin")`, no resource at all, which is exactly what an annotation-only check can express. A per-project delete decision needs the loaded project's `ownerId`, which only exists once a handler has fetched it — Path A's `guard`/`enforce` calls, not an annotation evaluated before any handler code runs, are the only place that resource can be supplied.

_Previous: [BEH-EA-158](20-qadi-bridge-path-b.md#beh-ea-158-the-permission-registry-route) | Next: [BEH-EA-160](20-qadi-bridge-path-b.md#beh-ea-160-both-bridges-share-one-wiring-root)_

## BEH-EA-160: Both bridges share one wiring root

```ts
export const AuthzLive = Layer.mergeAll(
  AuthorizedSubjectLive,
  RequirePermissionLive.pipe(Layer.provide(SubjectExtractorLive))
).pipe(Layer.provide(auth.layer))
```

```text
REQUIREMENT: An application using both Path A and Path B MUST provide both
             bridges from one merged `AuthzLive` Layer built over the same
             `auth.layer`; the two paths MUST NOT be wired from two
             independently-configured `SubjectResolver` instances.
```

`usage-qadi.md` §1 wires exactly this `AuthzLive` value once, merging `AuthorizedSubjectLive` and the `RequirePermissionLive`/`SubjectExtractorLive` pair over the same `auth.layer`. Both bridges ultimately call the same `SubjectResolver`, so wiring them from one root is what guarantees a `User` principal gets the identical `AuthSubject` — same roles, same permissions, same `actingAs` — whether the endpoint it hit was gated by Path A or Path B.

_Previous: [BEH-EA-159](20-qadi-bridge-path-b.md#beh-ea-159-choosing-path-b-over-path-a) | Next: [BEH-EA-161](21-qadi-resolvers-obligations.md#beh-ea-161-attributes-resolved-from-the-user-table)_
