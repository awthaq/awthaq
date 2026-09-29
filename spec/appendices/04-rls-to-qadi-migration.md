# Migrating Row-Level-Security Policies to Qadi
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-APP-04 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Appendix — Migration Guide |
> | Change History | 1.0 (2026-09-29): Initial release (SAM-005; supersedes the mapping notes that lived only in `OrganizationQadi.ts` header comments) |
---

Every code block below is an uncompiled illustration (fence language `ts`). It
is a migration guide for teams moving from Postgres row-level security (the
Supabase `auth.uid()` / `auth.jwt()` style) to awthaq + qadi, where
authorization is a set of typed policies evaluated by
[qadi](../decisions/009-authorization-delegated-to-qadi.md) instead of predicates
the database re-evaluates on every row. It exercises
[BEH-EA-162](../behaviors/21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership)
(organization relationships),
[BEH-EA-166](../behaviors/21-qadi-resolvers-obligations.md#beh-ea-166-sql-pushdown-and-its-limit)
(SQL pushdown) and [ADR-EA-017](../decisions/017-global-roles-vs-organization-roles.md).

## 1. Method: catalog first, then translate

1. **List every policy** (`select * from pg_policies`) and group them by table
   and command. This is the catalog; nothing is migrated that is not in it.
2. For each policy, name the *question* it answers (who may read / write which
   rows) and classify each term of its `USING` / `WITH CHECK` expression with the
   table in §2.
3. Write the qadi policy once, at module scope, next to the permission
   vocabulary ([appendix 02 §2](02-qadi-path-a-end-to-end.md)); enforce it in the
   handler (`guard`/`enforce`) or, for list queries, push it into SQL (§4).
4. Keep the RLS policy in place until the qadi path is proven, then drop it —
   the two are independent, so they can run side by side.

## 2. Mapping table

| RLS term | qadi/awthaq equivalent | Notes |
|---|---|---|
| `auth.uid() = user_id` (row ownership) | `hasResourceAttribute("ownerId", eq(subjectId()))`, evaluated against the row you loaded (`EvaluateOptions.resource`) | Resource attributes are a plain data bag the *caller* passes in — there is no "resource attribute resolver" |
| `exists (select 1 from memberships where org_id = t.org_id and user_id = auth.uid())` | `hasRelationship("member", { depth: 2 })` with `Organization.relationships` and your `ResourceOrganizationLookup` (project → organization) | `depth >= 1` walks through the lookup you provide; unresolved → `RelationshipResolveError`, never a silent deny |
| `... and role = 'admin'` | `hasRelationship("has-role:admin")` (alias `"admin"`) | Any built-in, static-custom or dynamic organization role: `has-role:<name>` |
| a per-org permission ("editors may update") | `hasRelationship("member:update")` — `<resource>:<action>` | Answered from the same effective statements the organization plugin's own endpoints gate on |
| `auth.jwt() ->> 'role' = 'service_role'` / platform staff | `hasRole("platform:support")` via `@awthaq/roles` | Global, tenant-blind authority ([ADR-EA-017](../decisions/017-global-roles-vs-organization-roles.md)) |
| `auth.jwt() -> 'app_metadata' ->> 'plan'` (a token claim) | a subject attribute: an `AttributeResolver` (built-in `userAttr("emailVerified")`, or your own `plan`) read with `hasAttribute` | **Token claims authenticate; they do not authorize.** awthaq does not project JWT claims into `AuthSubject` — re-home the fact into `Roles` (roles), organization relations (membership), or an attribute resolver, and read it from the live session |
| `auth.role() = 'anon'` | qadi's `anonymous` subject (every policy denies) | Use `OptionalAuthentication` + a `PublicEndpoint`/policy that allows it |
| `column-level` `USING` on selected fields | `FieldOptions` on the policy (`visibleFields`) and `enforceProjected` | Field visibility is part of the decision, not a separate view |

## 3. Shapes that do not translate directly

- **`SECURITY DEFINER` helper functions** used inside policies: there is no
  database function to call. Re-express the helper's logic as a qadi predicate
  (`hasCustom` registered in a `customPredicateFromRecord` table) or, better, as
  the relation/attribute it computes. Register `hasCustom` names through
  `customPredicateFromRecordChecked` so a typo fails at startup.
- **`storage.objects` path-prefix policies** (`(storage.foldername(name))[1] =
  auth.uid()::text`): model the prefix as a resource attribute the caller
  computes (`{ id, ownerId }` derived from the object key) and check ownership as
  above; there is no object store inside awthaq.
- **Policies that read another table per row** at list time: express the joined
  fact as an attribute on the resource you load, or push the qadi policy into the
  query (§4) so the database still filters.
- **Realtime / replication-time filtering**: out of scope — evaluate at the
  edge that serves the subscription.

## 4. List queries: push the policy into SQL

A handler that returns *one* row runs the policy against it. A handler that
returns *many* must not load everything and filter in memory; compile the same
policy to a row predicate with `@qadi/predicate-sql`'s `toPredicate`/
`compileSql` ([BEH-EA-166](../behaviors/21-qadi-resolvers-obligations.md#beh-ea-166-sql-pushdown-and-its-limit)) and append it to the `WHERE` clause. Policies that use relationships or custom predicates cannot be pushed down (a named limit) — those are enforced per row after a coarse SQL prefilter.

## 5. Worked example

A typical Supabase table and its policies:

```ts
// create policy "members read projects" on projects for select
//   using (exists (select 1 from org_members m
//                  where m.org_id = projects.org_id and m.user_id = auth.uid()));
// create policy "editors update projects" on projects for update
//   using (exists (select 1 from org_members m
//                  where m.org_id = projects.org_id and m.user_id = auth.uid()
//                    and m.role in ('owner', 'admin')));
```

The same rules in qadi, composed once and enforced in the handler:

```ts
// app/domain/authz.ts
export const canReadProject   = hasRelationship("member", { depth: 2 })
export const canUpdateProject = hasRelationship("member:update", { depth: 2 })
// depth: 2 — the resource is a project, and ResourceOrganizationLookup maps
// project → organization. "member:update" is the organization plugin's own
// statement, so owners/admins (and any dynamic role you grant it to) qualify —
// the SQL `role in ('owner','admin')` list disappears.

// app/wiring.ts
const ProjectOrg = Layer.succeed(ResourceOrganizationLookup, {
  organizationOf: (projectId) => Projects.use((p) => p.organizationOf(projectId)),  // Effect<Option<OrganizationId>>
})
const QadiLive = Layer.mergeAll(
  EvaluationServicesNone,
  OrganizationQadi.relationships.pipe(Layer.provide(ProjectOrg)),
)

// handler
update: ({ params, payload }) => Projects.use((p) => p.update(params.projectId, payload)).pipe(
  enforce(canUpdateProject, { resource: { id: params.projectId } }),
  Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id: params.projectId }))   // hide denial as 404
)
```

What changed in the guarantees: a non-member now gets the same `404` an unknown
project gets (RLS silently returned zero rows — equivalent observable behavior,
but explicit); a resolver outage is a `5xx` (`RelationshipResolveError`), never a
silent empty result; and the decision is auditable
(`DecisionSinkAudit` records every denial in the durable `AuditLog`).

## 6. Cache scope reminder

If you cache decisions, use the per-request `DecisionCache`
([appendix 02 §1](02-qadi-path-a-end-to-end.md)); an application-scoped cache
needs `DecisionCacheInvalidationLive`, which cannot see your own tables.
