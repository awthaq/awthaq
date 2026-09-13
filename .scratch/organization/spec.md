# Organization plugin — full better-auth feature parity

**Status:** ready-for-agent

## Problem Statement

An application built on effect-auth has no way to model multi-tenant
membership. `archive/PRD.md` names `Organization` (membership, invitations,
relationship resolver) as a Phase-2 plugin and treats it as a baseline
building block — installed unconditionally alongside `Password`, `Passkey`,
and `Roles` in the project's own north-star developer-experience examples —
not an exotic add-on. Today there is no organization entity, no membership
record linking a user to one, no invitation flow for adding members, no
per-organization role or permission model, no notion of a team within an
organization, and no way for an authorization policy built on qadi to ask
"is this subject a member of the organization that owns this resource"
without the application hand-writing that resolver itself.

The user (effect-auth's own developer-audience) explicitly asked that this
plugin "cover all the better-auth features" — better-auth being the
JS/TypeScript auth library whose own `organization` plugin is the closest
existing prior art for this exact feature area — and, restated twice during
this spec's own wayfinder grilling, that every design fork favor the
richest, most feature-complete option rather than a narrower subset.

## Solution

A new `@effect-auth/organization` plugin (`packages/organization`) —
already scaffolded as an empty package — gains a full `Organization`
`AuthPlugin.Service`, matching better-auth's Organization plugin's entire
documented capability set (organizations, per-membership and dynamic
per-org roles with a statement-based permission engine, invitations, teams,
lifecycle hooks, and active-organization/team session context), expressed
through effect-auth's own primitives rather than a literal port of
better-auth's own API surface:

- `AuthPlugin.Service`/`HttpApi` contract (matching every other plugin's
  own shape, e.g. `Admin`, `Passkey`)
- A self-contained, statement-based permission engine for the plugin's own
  endpoint gating — the same shape as better-auth's own `hasPermission`,
  not a bespoke reimplementation of qadi and not a dependency on
  `@effect-auth/qadi` (stratum ordering forbids it, mirroring `Admin`'s own
  resolved precedent)
- A `Layer.effect(RelationshipResolver, ...)` contribution matching the
  already-locked `BEH-EA-162` (`Organization.relationships`, `"member"`
  relation, depth-2 resource→org walk) extended with a `"team-member"`
  relation, plus a new `Layer.effect(AttributeResolver, ...)` contribution
  exposing a member's resolved organization role/permissions as qadi
  attributes — so *application*-level qadi policies can combine
  organization data with any other authorization concern, exactly as
  `usage-qadi.md` §7's worked example does
- The existing `HookPoint` mechanism (`veto`/`observe`), with `Organization`
  as its first real plugin consumer, covering every lifecycle moment
  better-auth's own `organizationHooks` documents
- The existing `Mailer` port for invitation delivery (already `Password`'s
  own pattern)
- A plugin-owned table for "active organization/team" session context,
  rather than reopening the shared core `Session` model a second time this
  cycle (`Admin` already added `actingAs` there)

## User Stories

1. As an application developer, I want to install `Organization` as a plain
   `AuthPlugin.Service` (`Auth.make([Organization, ...])`), so that it
   composes exactly like every other effect-auth plugin.
2. As an application developer, I want `Organization`'s migrations,
   contract, and table set to pass `runPluginContractTests` (table-prefix
   legality, no host-id collision, deterministic migrations), so that I can
   trust it the same way I trust `Admin`/`Passkey`.
3. As an end user, I want to create a new organization with a name and a
   unique slug, so that I have a place to invite my team.
4. As an end user, I want organization creation rejected with a typed error
   when my chosen slug is already taken, so that I get a clear, actionable
   failure instead of a silent collision.
5. As an end user, I want to optionally attach a logo URL and free-form
   metadata to my organization, so that I can brand and extend it for my
   own application's needs.
6. As an end user, I want the organization I just created to make me its
   owner automatically, so that I don't have to perform a second step to
   grant myself access.
7. As an application developer, I want to configure whether the creator
   becomes `owner` or `admin` by default, so that I can match my own
   application's conventions.
8. As an application developer, I want to configure whether users are
   allowed to create organizations at all (a predicate over the caller),
   so that I can restrict organization creation to an approval flow if I
   need to.
9. As an application developer, I want to configure a maximum number of
   organizations a single user may create, so that I can prevent abuse.
10. As an end user, I want to update my organization's name, slug, logo, or
    metadata, so that I can keep its details current.
11. As an end user, I want to check whether a slug is available before
    committing to it, so that I can pick a good one without a failed
    create attempt.
12. As an end user, I want to list every organization I belong to, so that
    I can see all my memberships at a glance.
13. As an end user, I want to fetch an organization's basic details
    (id/name/slug/logo/metadata) without pulling its full member/invitation
    list, so that a lightweight lookup stays cheap.
14. As an end user, I want to fetch an organization's full detail
    (including its members and pending invitations, paginated), so that I
    can build a management UI from one call.
15. As an end user, I want to delete an organization I own, so that I can
    tear down one I no longer need — cascading to remove its memberships,
    invitations, teams, and dynamic roles.
16. As an application developer, I want to be able to disable organization
    deletion entirely via configuration, so that I can protect against
    accidental data loss in deployments where organizations are meant to be
    permanent.
17. As an end user, I want to designate one organization (and optionally
    one team within it) as my "active" context, so that subsequent
    requests can be scoped to it without repeating the id on every call.
18. As an end user, I want to read back my currently active
    organization/team, so that a client application can restore my last
    context on load.
19. As an end user, I want to unset my active organization (pass `null`),
    so that I can return to an "unscoped" state.
20. As an end user, I want to list the members of an organization I belong
    to, with pagination, sorting, and filtering, so that I can manage a
    large membership list efficiently.
21. As an end user, I want to remove another member from an organization I
    administer, so that I can revoke their access.
22. As an end user, I want to update another member's role(s), so that I
    can promote or demote them.
23. As an end user, I want a membership to be able to hold more than one
    role simultaneously, so that role assignment is as flexible as
    better-auth's own comma-separated multi-role model.
24. As an application developer, I want the system to guarantee an
    organization always retains at least one member holding the `owner`
    role, so that an organization can never end up ownerless — rejecting
    any remove-member, update-role, or leave operation that would strip the
    last owner.
25. As an end user, I want to leave an organization I'm a member of, so
    that I can remove myself without needing another admin to do it for
    me.
26. As an application developer, I want a server-only way to add a user to
    an organization directly (no invitation round-trip), so that I can
    build my own bulk-provisioning or migration tooling on top of it.
27. As an end user, I want to fetch my own membership record and role(s)
    for the active organization in one call, so that a client can render
    role-gated UI without a second lookup.
28. As an application developer, I want a configurable cap on membership
    count per organization, so that I can enforce plan-based limits.
29. As an end user, I want three built-in roles (`owner`, `admin`,
    `member`) with sensible default permissions (owner/admin can manage
    the organization and its members and invitations; member is read-only),
    so that the plugin is useful without any custom configuration.
30. As an application developer, I want to override or extend the default
    permission statements per resource/action, so that I can define my own
    baseline roles beyond better-auth's three defaults.
31. As an application developer, I want to opt into dynamic access control,
    so that organizations themselves can define custom named roles with
    their own permission sets at runtime.
32. As an end user with sufficient permission, I want to create, list, get,
    update, and delete a custom role scoped to my organization, so that I
    can tailor permissions beyond the three built-in roles.
33. As an end user creating a custom role, I want to be blocked from
    granting that role any permission I don't already hold myself, so that
    I can never use dynamic roles to escalate my own privileges.
34. As an application developer, I want a configurable cap on the number of
    custom roles per organization, so that I can bound the feature's
    storage/complexity growth.
35. As an end user, I want my effective permissions in an organization to
    be the union of every role I hold (built-in and/or custom), so that
    multi-role assignment (story 23) composes correctly with dynamic roles.
36. As an application developer, I want `Organization`'s membership and role
    data exposed to qadi as a `RelationshipResolver` (the `"member"`
    relation, per the already-locked `BEH-EA-162`) and an `AttributeResolver`
    (a member's resolved role/permission data), so that my own
    application-level authorization policies can combine organization data
    with any other qadi-driven concern — with one line, per
    `usage-qadi.md` §7 — instead of writing that resolver myself.
37. As an application developer, I want organization-scoped permission
    checks on `Organization`'s own endpoints to work without me having to
    configure qadi at all, so that the plugin is useful out of the box —
    while still being fully able to compose with qadi for anything beyond
    the plugin's own endpoints.
38. As an end user, I want to invite someone by email to an organization
    with one or more roles, so that I can grow my organization's
    membership.
39. As an end user, I want re-inviting an already-invited email to be a
    no-op unless I explicitly ask for a resend, so that I don't
    accidentally spam an invitee.
40. As an application developer, I want the option to auto-cancel a prior
    pending invitation whenever the same email is re-invited, so that I
    never have two live invitations to the same address.
41. As an end user, I want inviting someone who is already a member to
    cancel any of their prior pending invitations, so that stale
    invitations don't linger for existing members.
42. As an invited user, I want to accept an invitation while logged in with
    an account whose email matches the invitation, so that I become a
    member of the target organization (and team, if the invitation named
    one).
43. As an invited user, I want to reject an invitation I don't want, so
    that it's cleared from my pending list.
44. As an end user who sent an invitation, I want to cancel it before it's
    accepted, so that I can retract an invite sent in error.
45. As an end user, I want to look up a single invitation by id, list every
    invitation for an organization, and list every invitation addressed to
    my own (verified) email, so that both an org admin and an invitee can
    see pending state.
46. As an application developer, I want invitations to expire after a
    configurable duration (defaulting to 48 hours), so that stale invites
    don't stay acceptable indefinitely.
47. As an application developer, I want a configurable cap on the number of
    pending invitations a single user can issue, so that I can prevent
    invitation spam.
48. As an application developer, I want invitation delivery to go through
    effect-auth's existing `Mailer` port, so that I configure email
    delivery the same way I already do for `Password`'s own verification
    and reset emails, rather than learning a new callback shape.
49. As an application developer, I want every pending invitation for an
    organization to be cleaned up automatically when that organization is
    deleted, so that no invitation ever survives referencing a
    nonexistent organization.
50. As an application developer, I want to opt into teams within an
    organization, so that I can model sub-groups without adopting a second
    plugin.
51. As an end user, I want to create, list, update, and remove a team
    within my organization, so that I can structure larger organizations
    into smaller working groups.
52. As an end user, I want to add and remove members of a team (drawn from
    the organization's existing membership), so that team composition
    stays a subset of organization membership, never a parallel identity.
53. As an end user, I want to designate an active team alongside my active
    organization, so that a client can scope requests to a specific team
    when relevant.
54. As an application developer, I want configurable caps on the number of
    teams per organization and members per team, and a configurable
    guard against removing an organization's last remaining team, so that
    I can enforce my own plan/structure limits, matching better-auth's own
    `maximumTeams`/`maximumMembersPerTeam`/`allowRemovingAllTeams`.
55. As an application developer, I want team membership exposed to qadi as
    its own `"team-member"` relation (distinct from organization-level
    `"member"`), so that application policies can gate on team membership
    specifically — a richer distinction than better-auth itself makes.
56. As an application developer, I want to tap a `veto` hook before every
    mutating operation (create/update/delete organization; add/remove
    member, update member role; create/accept/reject/cancel invitation;
    create/update/delete team, add/remove team member) to abort or amend
    it, and an `observe` hook after each to react to it, so that I can
    extend the plugin's behavior the same way better-auth's own
    `organizationHooks` before/after callbacks let me.
57. As an application developer, I want every one of `Organization`'s
    mutating operations to publish a durable, typed audit event (mirroring
    `Admin`'s own `auth.admin.*` event set), so that I can build
    observability and compliance tooling on top of organization activity.
58. As an end user, I want every error condition (slug collision,
    not-found, not-a-member, last-owner violation, permission denied,
    dynamic-role self-escalation, invitation expired/already-resolved,
    over any configured limit) to fail with a specific typed contract
    error, so that a client can render the exact right message rather than
    a generic failure.

## Implementation Decisions

**Package & composition.** `Organization extends AuthPlugin.Service<Organization, OrganizationShape>()("organization", {apiVersion: 1, contract: OrganizationApi, tables: [...]})`, `dependsOn: []` — reaches `Users`/`AuthEvents`/`Mailer` with a plain `yield*` inside `make`, mirroring the corrected convention `Admin`'s and `Passkey`'s own tickets already established (never a plugin-to-plugin dependency for core/port services). `OrganizationConfig` is a `Context.Reference` with a `config(partial)` override, mirroring `AdminConfig`/`PasswordConfig` exactly.

**Tables** (plugin-id-prefixed, matching `Admin`'s `admin_impersonation` convention): `organization`, `organization_membership`, `organization_invitation`, `organization_team`, `organization_team_membership`, `organization_role` (dynamic access control, only populated when that feature is enabled), `organization_active_context` (session→active-org/team lookup).

**Organization entity & CRUD.** Fields: `id`, `name`, `slug` (unique), `logo` (optional), `metadata` (optional, opaque JSON), `createdAt`. Operations: create (assigns the creator a membership with the configured `creatorRole`, default `owner`), update, delete (cascades to memberships, invitations, teams, dynamic roles — deletion itself can be disabled via `disableOrganizationDeletion`), list (caller's own memberships), get (metadata only) and get-full (metadata + paginated members + pending invitations), check-slug, set-active/set-active-team (writes to `organization_active_context`, see below).

**Membership.** `organization_membership`: `id`, `userId`, `organizationId`, `role` (an array of role names — richer than a single value, matching better-auth's own comma-separated multi-role capability translated into effect-auth's schema conventions), `createdAt`. Operations: list (paginated/sorted/filtered), remove, update-role, leave, get-active-member(-role) (reads the caller's own membership for whichever organization is currently active), and a server-only add-member (no invitation round-trip, for app-driven provisioning). The **owner invariant** — an organization must always retain at least one membership holding `owner` — is enforced natively (stricter than better-auth's own unenforced baseline) at every operation that could violate it: remove-member, update-member-role, and leave each reject with a typed error when the target is the organization's last owner.

**Roles & permissions — a self-contained, statement-based engine.** `Organization` ships its own resource/action permission-statement model (the same shape as better-auth's own): default statements grant `organization:[update,delete]`, `member:[create,update,delete]`, `invitation:[create,cancel]`, `team:[create,update,delete]` to `owner`/`admin`, and read-only to `member`; `OrganizationConfig` lets an application extend or override these defaults with its own custom static roles. This engine is what gates `Organization`'s own endpoints — a self-contained check over already-loaded membership/role data, not a network or qadi round-trip, so the plugin is fully functional with zero qadi configuration (unlike `Admin`'s deliberately fail-closed `canImpersonate`, ordinary organization management is expected to work out of the box). A member's effective permission set is the union of the statements for every role name they hold (built-in and/or dynamic).

**Dynamic access control** (opt-in via `OrganizationConfig.dynamicAccessControl.enabled`). `organization_role`: `id`, `organizationId`, `role` (name, unique per org), `permission` (a serialized resource→actions map, same shape as the static statements above), timestamps. create/delete/update/list/get operations, gated by the same statement engine (creating/managing dynamic roles requires the `ac:create`/`ac:read`-equivalent permission, granted to `owner`/`admin` by default) — critically, **a caller can never create or update a dynamic role to grant a permission they don't already hold themselves**, checked by comparing the requested permission set against the caller's own resolved set. `OrganizationConfig.dynamicAccessControl.maximumRolesPerOrganization` caps the count (number or predicate, default unlimited).

**qadi contribution.** Two `Layer.effect` contributions an application composes into its own `QadiLive`, exactly the mechanism `BEH-EA-161`/`BEH-EA-162` already lock (ordinary Effect Layers over qadi's own `AttributeResolver`/`RelationshipResolver` tags — no new slot or registry machinery needed):
- `Organization.relationships` — extends the already-specified `"member"` relation (depth-2 resource→organization walk) with a new `"team-member"` relation (resource→team walk), both mapping a lookup failure to `RelationshipResolveError`, never to `"Unrelated"`, per `BEH-EA-162`'s own requirement.
- `Organization.attributes` (new) — resolves an `AttributeResolver` attribute (e.g. `"orgRole"`/`"orgPermissions"`) from a subject's membership in whichever organization the check concerns, mirroring `BEH-EA-161`'s `UserAttributes` shape (`undefined` for "no opinion," a typed `AttributeResolveError` for a genuine lookup failure).

**Invitations.** `organization_invitation`: `id` (opaque, non-guessable — `crypto.randomUUIDv7`, matching `Admin`'s/`Passkey`'s own id-generation precedent), `email`, `inviterId`, `organizationId`, `teamId` (optional), `role` (array), `status` (`pending`/`accepted`/`rejected`/`canceled`/`expired`), `createdAt`, `expiresAt`. Operations: invite (re-inviting an already-pending email is a no-op unless `resend` is passed, or auto-cancels-then-reinvites when `cancelPendingInvitationsOnReInvite` is configured; inviting an existing member cancels any of their prior pending invitations), accept (requires the accepting session's email to match), reject, cancel, get, list-for-organization, list-for-user (the caller's own verified email only). Config: `invitationExpiresIn` (default 48h), `invitationLimit` (default 100), `cancelPendingInvitationsOnReInvite` (default off), `requireEmailVerificationOnInvitation` (default off, since invitation ids are non-guessable by construction — overridable to on). Deleting an organization cascades to remove all its pending invitations.

**Teams** (opt-in via `OrganizationConfig.teams.enabled`). `organization_team`: `id`, `name`, `organizationId`, `memberCount`, timestamps. `organization_team_membership`: `id`, `teamId`, `userId`, `createdAt` — adding a team member requires the target already be a member of the team's own organization. Operations: create/list/update/remove-team, add/remove-team-member, list-team-members, list-user-teams, set-active-team. Config: `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams` (default `false` — blocks deleting an organization's last remaining team), matching better-auth's own defaults.

**Lifecycle hooks.** `Organization` declares one `HookPoint` (`veto` for every before-operation, `observe` for every after-operation) per mutating operation named in the user stories above (organization create/update/delete; member add/remove/update-role; invitation create/accept/reject/cancel; team create/update/delete, team-member add/remove) — the first real plugin consumer of the existing core `HookPoint` mechanism (`BEH-EA-089`–`096`). Each veto point's `Input` is that operation's own payload/context; each observe point additionally carries the resulting record.

**Active organization/team state.** `organization_active_context`: keyed by `sessionId` (unique), `activeOrganizationId` (optional), `activeTeamId` (optional), `updatedAt` — a plugin-owned table rather than a new column on the shared core `Session` model (which `Admin` already extended once this cycle with `actingAs`). `set-active`/`set-active-team` upsert this row for the caller's current session; reads (`get-active-member`, `get-active-member-role`, and any endpoint defaulting to "the active organization" when no explicit id is passed) join through it. This row is **not** actively cascade-deleted when its underlying session is revoked — an orphaned row is harmless (the next read simply finds no matching session) — a documented, deliberate scope limit mirroring the same "declare the gap rather than build unrequested session-lifecycle plumbing" posture `Admin`'s own `endedBy: "expired"` gap already sets as precedent for this codebase.

**Audit events.** One `auth.organization.*` event per mutating operation (organization created/updated/deleted; member added/removed/role-updated; invitation created/accepted/rejected/canceled; team created/updated/deleted; team member added/removed; dynamic role created/updated/deleted), added to the closed `AuthEvent` union in `AuthEvents.ts`, mirroring `Admin`'s own three-event set.

**Mailer.** Invitation delivery reuses the existing `Mailer` port (`send({to, template: "organization-invite", data: {...}})`) — no new port, no bespoke callback config, matching `Password`'s own established usage.

## Testing Decisions

The **highest, primary seam** is a wire-level contract test over a real `HttpRouter`/`HttpRouter.toWebHandler` (`packages/organization/test/AuthHttp.test.ts`), mirroring `packages/admin/test/AuthHttp.test.ts` and `packages/passkey/test/AuthHttp.test.ts` exactly: real HTTP requests/responses, real status codes, a real session cookie, plus `runPluginContractTests` (from `@effect-auth/test`) exercised against the real `Organization` plugin class. Only external behavior through the contract is asserted — never internal repository shape.

Supporting seams, each mirroring an existing precedent in this codebase:
- Domain-level tests (`Organization.test.ts`) covering every case in the user stories above directly against `OrganizationShape` (in-memory layers), the same shape `Admin.test.ts` and `Passkey.test.ts` already take.
- Persistence-layer contract-suite tests for each new repository (organization/membership, invitation, team/team-membership, dynamic role, active-context), each exercised against both `layerMemory` and `layerSql`, mirroring `ImpersonationRecords.test.ts`/`PasskeyCredentials.test.ts`.
- Composition tests (`AuthComposition.test.ts`) asserting `Auth.make([Organization])` composes and the manifest's `tables`/`dependsOn` are correct.
- A qadi-integration test proving the contributed `RelationshipResolver`/`AttributeResolver` `Layer`s answer correctly once composed into a real `QadiLive`-shaped test layer and exercised through `hasRelationship`/`hasResourceAttribute`-style policies, mirroring `usage-qadi.md` §7's own worked example — this is the one genuinely new seam this plugin needs beyond what `Admin`/`Passkey` already established, since neither of those plugins contributes a qadi resolver.

## Out of Scope

- The future `Sso` plugin's own dependency on `Organization` (`archive/design/09-sso.md`, `MOD-EA-009`) — a separate future effort that will consume whatever this plugin ships; this spec does not need to anticipate its exact needs.
- A generic, reusable "plugin-contributed authorization predicate" abstraction — `Organization`'s own self-contained statement engine and `Admin`'s config-supplied predicate remain two independently-shaped patterns for now; extracting a shared abstraction is deferred until a third plugin needs the same shape.
- Client-side bindings/hooks (`useActiveOrganization()`-equivalent) — effect-auth derives its client from the plugin's own `HttpApi` contract (`@effect-auth/client`/`@effect-auth/react`'s existing, generic mechanism), so no plugin-specific client surface needs designing here.
- Any resolution to `spec/behaviors/21-qadi-resolvers-obligations.md`'s already-documented "two plugins both wiring a resolver for the same attribute/relation" gap — `Organization` is simply one more contributor into that same, already-acknowledged-as-unresolved landscape.
- CLI tooling (`seed admin`-equivalent, `plugin list --graph` support) for this plugin specifically — covered by the separate, still-unbuilt `@effect-auth/cli` package, not this spec.

## Further Notes

This spec directly resolves the `Organization` wayfinder map's (`.scratch/organization/map.md`) five open grilling tickets (02 — authorization boundary, 03 — core schema, 04 — teams, 05 — dynamic access control, 06 — invitations, 07 — lifecycle hooks, 08 — active organization/team state) as part of synthesizing this spec, per `/to-spec`'s own "do not interview, just synthesize" instruction. Those tickets should be closed with a pointer to this spec's relevant "Implementation Decisions" subsection rather than separately re-grilled — the map's own frontier is now empty and its destination reached.

Every design fork in this spec defaults to the richest, most feature-complete option per the standing preference confirmed twice during this effort's own grilling rounds (see `feedback-flexibility-over-complexity` in project memory), with two narrow, explicitly-flagged exceptions where a specific safe default was chosen instead of "on by default": dynamic access control and teams both default to **disabled** (an explicit one-flag opt-in, fully built either way) and the active-organization-context row is **not** actively cascade-deleted on session revocation (an orphaned-but-harmless row, mirroring `Admin`'s own documented `endedBy: "expired"` gap) — both are default/config-value judgment calls, not scope reductions, consistent with how that same preference was earlier stated to apply.

No `BEH-EA` id range has been allocated yet for this plugin (`spec/behaviors/index.yaml` currently ends at `BEH-EA-209` for `Admin`); allocating one and writing the corresponding `spec/behaviors/28-organization.md` file is expected as the first step of turning this spec into tickets via `/to-tickets`, the same sequencing `Admin` itself followed.
