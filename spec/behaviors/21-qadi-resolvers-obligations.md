# Qadi Resolvers and Obligations
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-21 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added the INV-EA-012 callout to BEH-EA-161 and a note on unhandled same-attribute/relation resolver conflicts across plugins (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-161: Attributes resolved from the user table

> **Invariant:** [INV-EA-012](../invariants.md#inv-ea-012-a-qadi-resolvers-failure-never-becomes-an-authorization-denial)

```ts
export const UserAttributes = Layer.effect(AttributeResolver, Effect.gen(function*() {
  const users = yield* Users
  return AttributeResolver.of({
    name: "awthaq/UserAttributes",
    resolve: (subjectId, attribute) => users.byId(id).pipe(
      Effect.map((u) => attribute === "plan" ? u.plan : undefined),
      Effect.mapError((cause) => new AttributeResolveError({ subjectId, attribute, cause }))
    )
  })
}))
```

```text
REQUIREMENT: An `AttributeResolver` backed by awthaq's user table MUST
             map a lookup failure to `AttributeResolveError`, never to
             `undefined`-as-deny or to a swallowed exception; `undefined` MUST
             mean only "this resolver has no opinion on this attribute."
```

`usage-qadi.md` §6.1 draws the line precisely: the resolver returns `undefined` for an attribute it does not recognize (`type !== "user"`, or an unhandled attribute name), and maps every genuine failure — a database error reading `users.byId` — to a typed `AttributeResolveError` instead. Collapsing those two cases would make an outage of the user table indistinguishable from "this subject has no plan," turning an infrastructure failure into a silent authorization decision.

_Previous: [BEH-EA-160](20-qadi-bridge-path-b.md#beh-ea-160-both-bridges-share-one-wiring-root) | Next: [BEH-EA-162](21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership)_

## BEH-EA-162: Relationships resolved from organization membership

```ts
export const OrgRelationships = Layer.effect(RelationshipResolver, Effect.gen(function*() {
  const org = yield* Organization
  return RelationshipResolver.of({
    name: "awthaq/OrgRelationships",
    check: ({ subjectId, relation, resourceId, depth }) => /* … */.pipe(
      Effect.mapError((cause) => new RelationshipResolveError({ subjectId, relation, resourceId, cause }))
    )
  })
}))
```

```text
REQUIREMENT: `Organization.relationships` MUST resolve a `"member"` relation
             by walking from the resource to its owning organization and
             checking membership there; a lookup failure MUST map to
             `RelationshipResolveError`, never to `"Unrelated"`.
```

**Shipped shape (RZS-001/RZS-005/RZS-006/RZS-004).** The walk needs domain knowledge only the application has ("this resource id is a project, and `Projects.organizationOf(id)` is its organization"), so `OrganizationQadi.relationships` *requires* an application-provided `ResourceOrganizationLookup` port (`organizationOf: (resourceId) => Effect<Option<organizationId>, unknown>`; `ResourceOrganizationLookup.layerNone` is the explicit "no walking configured" choice, ADR-EA-010). `"member"` at `depth >= 1` consults it; `depth` undefined/0 treats `resourceId` as the organization itself; `Option.none()` or a failed lookup is a `RelationshipResolveError`, never `"Unrelated"`. The relation grammar is `member`, `has-role:<name>` (any built-in, static-custom or dynamic role; `admin`/`owner` are aliases), `<resource>:<action>` (answered from the very effective statements the plugin's own `requirePermission` gates with, so a qadi policy and the plugin can never disagree) and `team-member`. Anything else — and an organization-scoped relation naming no organization, or `team-member` naming no team — is qadi's `"Unknown"`, distinguishable from a genuine `"Unrelated"` in traces. `member` and `has-role:*` are one indexed membership lookup; only `<resource>:<action>` computes statements.

`usage-qadi.md` §6.2 documents the depth-2 walk ("`\"member\"` of a project = member of the project's organization; depth 2 walks project → org") and ships it as `Organization.relationships` specifically so an application installing the `Organization` plugin gets `hasRelationship("member", { depth: 2 })` working "with one line instead of writing it" (§7) — the resolver is part of what the plugin contributes, not something every application authors from scratch. `relationshipResolverFromEdges` remains available for fixed, small graphs (tests, or deployments with no organization plugin at all).

**Consistency (non-normative).** Delegation to qadi is deliberate (ADR-EA-009): awthaq ships no Zanzibar-style consistency machinery (no zookies, no revision tokens). The freshness contract sits at the resolver seam instead: a relationship answer is exactly as fresh as the organization records layer it reads. A request-scoped `DecisionCache` (the default, [BEH-EA-145](19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject)) preserves that freshness; an application-scoped cache needs `DecisionCacheInvalidationLive` (organization/team membership and dynamic-role changes clear it) and, for application-owned resolvers, the application's own `DecisionCache.clear`. An application that outgrows this resolver — wanting OpenFGA or SpiceDB `check` calls — replaces the `OrganizationQadi.relationships` layer with one backed by that engine; membership tuples must then be exported from the `AfterAddMember`/`AfterRemoveMember` hook points. No adapter for such an engine ships (no speculative infrastructure).

_Previous: [BEH-EA-161](21-qadi-resolvers-obligations.md#beh-ea-161-attributes-resolved-from-the-user-table) | Next: [BEH-EA-163](21-qadi-resolvers-obligations.md#beh-ea-163-fixed-graphs-use-relationshipresolverfromedges)_

## BEH-EA-163: Fixed graphs use `relationshipResolverFromEdges`

```ts
relationshipResolverFromEdges([{ subjectId: "user:u1", relation: "member", resourceId: "p1" }])
```

```text
REQUIREMENT: A deployment or test with a small, statically known relationship
             graph MAY use `relationshipResolverFromEdges` instead of
             `Organization.relationships`; both MUST implement the same
             `RelationshipResolver` interface interchangeably.
```

`usage-qadi.md` §6.2 notes this is "enough" when the graph is fixed — a test suite (`usage-qadi.md` §15's `edgeRelationshipResolver`), or a deployment that has no organization plugin installed at all but still wants a couple of hard-coded relationships. Because both implementations satisfy the same `RelationshipResolver` tag, a policy written against `hasRelationship` never needs to know or care which backing implementation is in effect.

**Two plugins both wiring a resolver for the same attribute or relation** is, honestly, an unhandled case today, and worth stating plainly rather than implying a check exists. `AttributeResolver` and `RelationshipResolver` are qadi's own service tags (`@qadi/core`), not one of awthaq's own declared slots (`SubjectResolver`, `SessionViewExtension` — ADR-EA-012), so `Auth.make`'s `SlotConflict<P>` check (INV-EA-004) has no visibility into them: it only detects a collision between two plugins' `ROut` for a slot *awthaq itself* defines. If, say, both `Organization` and a hypothetical third-party `Billing` plugin each provide a `Layer.effect(AttributeResolver, ...)` for the `"plan"` attribute, ordinary Effect Layer composition applies — the later-provided Layer shadows the earlier one for that tag, the same shadow-not-merge semantics `behaviors/14-rate-limiting.md`'s BEH-EA-109 documents for two `RateLimiter` store Layers — and the losing resolver's contribution is silently unreachable, with no name-both-plugins compiler error the way an actual slot conflict gets. Closing this gap would mean either classifying `AttributeResolver`/`RelationshipResolver` as awthaq-recognized slots (extending `SlotConflict<P>` to see through to a qadi-owned tag it does not otherwise know about) or introducing an aggregating combinator that tries each contributed resolver in order and takes the first non-`undefined` answer, mirroring how `undefined` already means "no opinion" per BEH-EA-161's own resolver contract — neither of which this specification commits to today. Until one of those exists, an application composing more than one resolver for the same attribute or relation is responsible for either combining them into a single Layer itself before providing it, or ensuring no two installed plugins target the same attribute/relation name at all.

_Previous: [BEH-EA-162](21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership) | Next: [BEH-EA-164](21-qadi-resolvers-obligations.md#beh-ea-164-decision-history-backed-by-audit-events)_

## BEH-EA-164: Decision history backed by audit events

```ts
export const TermsHistory = Layer.effect(DecisionHistory, Effect.gen(function*() {
  const audit = yield* AuditLog   // fed by AuthEvents.on(…) subscriptions
  return DecisionHistory.of({
    hasActed: ({ subjectId, event }) => audit.exists(subjectId, event).pipe(
      Effect.map((b) => b ? "Acted" as const : "NotActed" as const),
      Effect.mapError((cause) => new DecisionHistoryUnavailable({ cause }))
    )
  })
}))
```

```text
REQUIREMENT: A `DecisionHistory` implementation backed by awthaq's audit
             table MUST answer `hasActed` from durable event records, never
             from in-memory state; a query failure MUST map to
             `DecisionHistoryUnavailable`, not to `"NotActed"`.
```

`usage-qadi.md` §6.3 shows `hasActed("accepted-terms")` gating an entire API until a subject has taken some prior action, fed by the same `AuthEvents` subscription mechanism file 13 specifies. Answering `"NotActed"` on a database outage would let a broken audit table silently deny every subject who genuinely has acted, which is why the outage gets its own typed error instead — the same "failure is not denial" discipline as the other two resolvers, applied to a question about the past rather than the present.

_Previous: [BEH-EA-163](21-qadi-resolvers-obligations.md#beh-ea-163-fixed-graphs-use-relationshipresolverfromedges) | Next: [BEH-EA-165](21-qadi-resolvers-obligations.md#beh-ea-165-the-reauth-obligation-discharges-from-session-freshness)_

## BEH-EA-165: The reauth obligation discharges from session freshness

```ts
export const reauth = obligation("awthaq/reauth", { maxAgeSeconds: 300 })
export const canChangeEmail = obliged(reauth, hasPermission(permission("account", "update")))

changeEmail: ({ payload }) => Users.use((u) => u.changeEmail(payload.email)).pipe(
  enforce(canChangeEmail, { onObligations: ObligationHandlers.reauth })
)
```

```text
REQUIREMENT: `ObligationHandlers.reauth` MUST compare the current session's
             `authenticatedAt` timestamp to the obligation's `maxAgeSeconds`
             and MUST fail with a typed re-authentication error when stale; it
             MUST NOT accept a session merely because it is currently valid,
             independent of when it was last authenticated. A `reauth`
             obligation the handler cannot interpret (no finite, non-negative
             numeric `maxAgeSeconds`) MUST fail loudly rather than discharge,
             and among several `reauth` duties the strictest window wins.
             The re-authentication error MUST be wire-decodable
             (`Api.ReauthRequired`, `{ maxAgeSeconds }`, HTTP 403) so a client
             can tell it from a plain permission denial.
```

`usage-qadi.md` §8 states the mechanism directly: the handler "reads `CurrentPrincipal`'s session, compares `authenticatedAt` to the obligation's `maxAgeSeconds`, and fails with a typed error the client maps to a 'confirm your password' screen." This is the step-up authentication pattern applied through qadi's obligation mechanism rather than as a bespoke check in the `changeEmail` handler — the handler declares the requirement (`obliged(reauth, ...)`) and awthaq supplies the one discharge implementation every such requirement uses.

**Wire shape and the Path A / Path B split (EEM-005).** The error is a shared `Schema.TaggedError` in `@awthaq/api`, not a plain `Data.TaggedError`: a Path A endpoint whose policy carries `reauth(...)` declares `Api.ReauthRequired` in its `error:` array and a generated client decodes it. Path B (`RequirePermission`) cannot carry it — qadi's middleware owns that response mapping and answers an undischarged obligation with `UndischargedObligation` ([BEH-EA-160](20-qadi-bridge-path-b.md#beh-ea-160-both-bridges-share-one-wiring-root)) — so a step-up flow uses Path A.

_Previous: [BEH-EA-164](21-qadi-resolvers-obligations.md#beh-ea-164-decision-history-backed-by-audit-events) | Next: [BEH-EA-166](21-qadi-resolvers-obligations.md#beh-ea-166-sql-pushdown-and-its-limit)_

## BEH-EA-166: SQL pushdown, and its limit

```ts
const predicate = yield* toPredicate(canReadProject)
const where = yield* compileSql(predicate, { dialect: "postgres" })
return yield* sql<Project>`SELECT * FROM project WHERE ${sql.unsafe(where.text, where.params)} ORDER BY created_at DESC LIMIT 50`
```

```text
REQUIREMENT: A policy compiled to SQL via `toPredicate` and `compileSql` MUST
             fail with `PredicateNotRenderable` when it contains a
             `hasRelationship` node, rather than silently omitting or
             approximating that part of the policy; the caller MUST split
             such a policy into a SQL-rendered part and a `filter`-evaluated
             part.
```

`usage-qadi.md` §9 states this exactly: "`hasRelationship` nodes cannot be rendered to SQL; `compileSql` fails with `PredicateNotRenderable` rather than approximating." Approximating would be worse than failing loudly — a query that silently dropped the relationship condition could return rows a subject is not actually entitled to see, which is precisely the class of bug SQL pushdown is meant to avoid by construction, not merely defer to the application layer.

_Previous: [BEH-EA-165](21-qadi-resolvers-obligations.md#beh-ea-165-the-reauth-obligation-discharges-from-session-freshness) | Next: [BEH-EA-167](21-qadi-resolvers-obligations.md#beh-ea-167-a-sink-cannot-change-a-decision)_

## BEH-EA-167: A sink cannot change a decision

```ts
export const Sinks = decisionSinkAll([
  ring.layer, feed.layer,
  AuditDecisionSinkLive({ failureThreshold: 5 }).pipe(Layer.provide(AuthAuditTrail.layer))
])
```

```text
REQUIREMENT: A broken or unreachable audit `DecisionSink` MUST trip its own
             breaker and log; it MUST NOT block, delay, or alter the answer
             already returned to the request that produced the decision being
             audited.
```

`usage-qadi.md` §10 states this as a design property, not an incidental behavior: "A sink cannot change a decision; a broken audit trail trips the breaker and logs, and the request still gets its answer." Audit is downstream of authorization, never upstream of it — `AuditDecisionSinkLive`'s `failureThreshold` breaker exists so a durable-storage outage degrades to "this decision went unaudited" (itself logged) rather than to "this request now fails because auditing failed."

_Previous: [BEH-EA-166](21-qadi-resolvers-obligations.md#beh-ea-166-sql-pushdown-and-its-limit) | Next: [BEH-EA-168](21-qadi-resolvers-obligations.md#beh-ea-168-the-guarded-devtools-decision-stream)_

## BEH-EA-168: The guarded devtools decision stream

```ts
decisionStreamRoute(adminAccess, hasRole("admin"), feed.stream, { reauth: { every: "30 seconds" } })
```

```text
REQUIREMENT: A live decision stream exposed for devtools MUST be guarded by a
             policy and MUST re-check the viewing subject at the configured
             interval; a viewer whose access is revoked mid-stream MUST stop
             receiving further decisions once the next re-check runs.
```

`usage-qadi.md` §10 wires `decisionStreamRoute` with `reauth: { every: "30 seconds" }` specifically because a long-lived stream connection is exactly the kind of access a point-in-time check does not cover — an admin who is demoted while watching the feed should lose the feed within the re-check window, not keep watching every decision in the system indefinitely on the strength of a permission they no longer hold.

_Previous: [BEH-EA-167](21-qadi-resolvers-obligations.md#beh-ea-167-a-sink-cannot-change-a-decision) | Next: [BEH-EA-169](22-client-effect.md#beh-ea-169-the-client-derives-from-the-merged-contract)_
