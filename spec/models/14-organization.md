# Organization
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-14 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-002) |
---

## What it is

A plan for an `Organization` plugin that gives an application multi-tenant
membership: an organization entity, membership rows linking users to
organizations, an invitation flow for adding new members, and — distinct from
those CRUD concerns — a `RelationshipResolver` it contributes to qadi so that
authorization policies can ask "is this subject a member of the organization
that owns this resource" without the application hand-writing that resolver
itself. `archive/PRD.md` §17's Phase-2 row describes it exactly this way:
"`Organization` (membership, invitations, relationship resolver)." Nothing
described here exists yet — awthaq is pre-implementation.

## Who asks for it

`archive/PRD.md` §26's north-star developer-experience snippet installs
`Organization` unconditionally alongside `Password`, `Passkey`, and `Roles`
(`Auth.make([Password, Passkey, Organization, Roles])`), and §183's plugin
composition example repeats the same tuple shape
(`Auth.make([Password, Passkey, OAuth, Organization, Roles])`) — both treat
organization membership as a baseline building block for applications that
have any notion of a team or tenant, not an exotic add-on. `archive/PRD.md`
§15 (Authorization: qadi) names `Organization.relationships` directly as one
of the three resolvers awthaq is expected to wire against qadi's fail-closed
defaults ("relationships from organization membership
(`Organization.relationships`)"), alongside attributes from the user table and
decision history from audit events — so this plugin is asked for both by
applications that need multi-tenant membership as a domain feature and by the
authorization bridge itself, which has nowhere else to source a relationship
resolver from.

## Status

| Property | Value |
|---|---|
| Status | Planned-Phase2 |
| Priority | P1 |
| Enabler(s) | E3 — Principal-type extension (a membership/invitation domain needs its own tables and repositories, the same shape of enabler API Keys and JWT/Bearer draw on); see also `00-adoption-matrix.md` §6 for the open question on whether a dedicated enabler category is needed for relationship-resolver wiring specifically. |
| Breaking? | Additive: no existing plugin, port, or slot is redefined. `Organization` is a new plugin contributing new tables (`organization`, `organization_membership`, `organization_invitation`, exact names undecided) and a new `RelationshipResolver` contribution; it does not reopen any Planned-MVP contract. |

## How it would be expressed

Following `archive/PRD.md` §9.1's `AuthPlugin.Service` shape, and the
`organization()` factory named in `archive/design/usage-examples-v4.md` §2.1:

```ts
export class Organization extends AuthPlugin.Service<Organization, OrganizationShape>()("organization", {
  apiVersion: 1,
  contract: OrganizationApi,
  tables: ["organization", "organization_membership", "organization_invitation"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Organization, {
    dependsOn: [Users],
    make: Effect.gen(function*() {
      /* create/list organizations, invite/accept/revoke membership,
         isMember(orgId, userId), memberCount(orgId) — the primitives
         §6.2 and §7 of usage-qadi.md build the resolver and policies from */
      return Organization.of({ create, invite, isMember, memberCount, relationships })
    }),
    handlers: OrganizationHandlers
  })
}
```

`archive/design/usage-qadi.md` §6.2 shows the shape the contributed
`RelationshipResolver` is expected to take once this plugin exists — a
`Layer.effect(RelationshipResolver, ...)` that reads `Organization` and
resolves `"member"` relationships by walking from a resource to the
organization that owns it, so the plugin's own job is to expose primitives
like `isMember` and `memberCount` that such a resolver (and `usage-qadi.md`
§7's organization-scoped policies) are built on top of, not to define the
resolver's exact wiring itself — see What is missing below.

## Worked example

`archive/design/usage-qadi.md` §6.2 and §7 sketch how this plugin's data is
expected to be used once it exists, so this is not a fabricated worked
example but a boundary note on how far the existing cookbook material goes:

```ts
// §6.2 — RelationshipResolver contributed against Organization
export const OrgRelationships = Layer.effect(RelationshipResolver, Effect.gen(function*() {
  const org = yield* Organization
  return RelationshipResolver.of({
    name: "awthaq/OrgRelationships",
    check: ({ subjectId, relation, resourceId, depth }) => Effect.gen(function*() {
      const [type, userId] = subjectId.split(":")
      if (type !== "user") return "Unrelated" as const
      const orgId = yield* Projects.use((p) => p.organizationOf(resourceId as ProjectId))
      const isMember = yield* org.isMember(orgId, userId as UserId)
      return isMember ? "Related" as const : "Unrelated" as const
    })
  })
}))
// policy: hasRelationship("member", { depth: 2 })
```

```ts
// §7 — an organization-scoped policy built on top of that resolver
export const canInvite = allOf([
  hasPermission(project.invite),
  hasRelationship("member", { depth: 2 }),
  hasResourceAttribute("membershipCount", lt(literal(100)))
])
```

Both fences are adapted from `archive/design/usage-qadi.md` (already `ts`
fences in the source). Neither file shows the `Organization` plugin's own
service surface (its handlers, its table shapes, or the `create`/`invite`
API this model sketches above) being defined — only how an application is
expected to consume `Organization.isMember` and `Organization.memberCount`
once they exist. `archive/design/usage-examples-v4.md` §2.1 shows only the
one-line `organization()` factory call in a plugin list; it carries no
further worked example of the plugin's own contract.

## What is missing

No port or table schema has been decided: `organization`,
`organization_membership`, and `organization_invitation` above are inferred
from `archive/PRD.md` §17's parenthetical ("membership, invitations,
relationship resolver"), not fixed by any design document. There is no
`OrganizationApi` contract, no decision on invitation-flow behavior (token
shape, expiry, re-invitation, revocation), no decision on whether membership
carries its own per-organization role beyond what the `Roles` plugin already
resolves, and — critically for `09-sso.md`'s dependency on this plugin — no
decision on how a `RelationshipResolver` contribution is wired into the
`QadiLive` layer alongside the fail-closed resolver defaults
`archive/design/usage-qadi.md` §6 names (`UserAttributes`, `OrgRelationships`,
`TermsHistory` replacing `CustomPredicateNone`, `SignatureHistoryNone`, and
so on). None of this has an allocated `BEH-EA` id; this plugin has no
behaviors file.

## Verification

None yet — no test exists.

_Related: [MOD-EA-009 — SSO](09-sso.md) (depends on this plugin as a hard
dependency, per its own `dependsOn: [Sessions, Users, Organization]`), 
[ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md) (qadi
delegation — this plugin's `RelationshipResolver` contribution is the
concrete instance of that delegation for organization membership), 
[00 — Adoption Matrix](00-adoption-matrix.md)_
