# Organization Plugin — Multi-Tenancy, Membership, and Organization-Scoped Access Control

> Builds on `01-access-control.md` (the `authorize` arrow, statements,
> roles — cross-referenced throughout, never restated) and
> `02-admin-plugin.md` (the same "instantiate the primitive once, add a
> `hasPermission` wrapper with an outer OR across held roles" shape — used
> again here with organization-specific extensions). Also builds on the
> core session/entity invariants of `01-core-domain/`.

The organization plugin is the largest surface in this tree: it adds a
tenancy boundary (organization), a membership entity binding users to
organizations with a role, an invitation flow, optional sub-groups
(teams), an active-organization/active-team extension to the session
entity, and — optionally — a *dynamic*, storage-backed extension of the
access-control primitive itself (organization-defined custom roles).

---

## 1. Entity model

```
┌───────────────┐        ┌──────────────────────────┐
│      User      │        │       Organization        │
│ (core domain)  │        │  id, name, slug, logo,     │
└───────┬────────┘        │  metadata, createdAt       │
        │                 └───────────┬────────────────┘
        │ 1                           │ 1
        │                             │
        │            ┌────────────────┼─────────────────┬───────────────┐
        │            │                │                  │               │
        │ *          │ *              │ *                │ *             │ *
┌───────▼────────────▼───┐  ┌─────────▼─────────┐  ┌─────▼──────┐  ┌─────▼───────────┐
│        Member           │  │     Invitation      │  │   Team     │  │ OrganizationRole │
│ organizationId, userId, │  │ organizationId,     │  │ id, name,  │  │ (dynamic AC only) │
│ role (comma-joined),    │  │ email, role,        │  │ organiza-  │  │ organizationId,   │
│ createdAt               │  │ status, expiresAt,  │  │ tionId,    │  │ role, permission   │
│                          │  │ teamId(s), inviterId│  │ memberCount│  │ (JSON statements)  │
└──────────────────────────┘  └─────────────────────┘  └─────┬──────┘  └────────────────────┘
                                                               │ *
                                                       ┌───────▼────────┐
                                                       │   TeamMember     │
                                                       │ teamId, userId    │
                                                       └───────────────────┘

Session (core domain) is extended with:
   activeOrganizationId?: string     (this plugin's schema addition)
   activeTeamId?: string             (added only when teams.enabled)
```

A **Member** is the binding entity: it is what makes a user "in" an
organization, and it is the entity whose `role` field every
organization-scoped permission check ultimately resolves. A user with no
Member row for an organization is not a member of it, full stop — no
other entity substitutes for membership.

---

## 2. Membership hierarchy diagram

```
                                   User "alice"
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │ Member(role=owner)       │ Member(role=member)      │ (no Member row)
              ▼                          ▼                          ▼
      Organization "acme"        Organization "beta"        Organization "gamma"
              │                          │                  alice cannot read/act on
      ┌───────┴───────┐                  │                  "gamma" at all — there
      │               │           (teams disabled           is no partial visibility;
   Team "eng"     Team "sales"     for this org)             membership is binary.
      │               │
      │ TeamMember     │ TeamMember
      ▼               ▼
   alice is a       alice is NOT
   team member       a team member
   of "eng"          of "sales" —
                      team membership
                      is independent
                      of org membership
                      granting no extra
                      org-level rights
                      by itself.

  Invariant across the whole tree: a user's ROLE is scoped per
  organization (Member.role), never global — the same user can be
  "owner" of one organization and "member" of another simultaneously,
  and the plugin never conflates the two. Team membership is a further,
  independent sub-grouping WITHIN one organization; it does not carry
  its own role or permission set in the static-role model — it exists
  for scoping (e.g. which team's roster a `member:update`-holder can see)
  and for the active-team session pointer (§6), not for authorization
  itself. (Team-resource actions like `team:update`/`team:delete` are
  still governed by the ORGANIZATION-level role, not by team membership.)
```

---

## 3. The default statement universe and default roles

```
┌───────────────────────────────────────────────────────────────────┐
│                 ORGANIZATION STATEMENTS UNIVERSE                    │
│                                                                        │
│   organization: update, delete                                       │
│   member:       create, update, delete                               │
│   invitation:   create, cancel                                       │
│   team:         create, update, delete                               │
│   ac:           create, read, update, delete   (dynamic-AC roles)    │
└───────────────────────────────────────────────────────────────────┘

            admin              owner              member
      ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
      │org:   update ✓  │ │org: update ✓    │ │org:   (none)   │
      │       delete ✗  │ │     delete ✓    │ │                │
      │member: all ✓    │ │member: all ✓    │ │member: (none)  │
      │invite: all ✓    │ │invite: all ✓    │ │invite: (none)  │
      │team:  all ✓     │ │team:  all ✓     │ │team:  (none)   │
      │ac: create/read/ │ │ac: create/read/ │ │ac: read only ★ │
      │    update/      │ │    update/      │ │                │
      │    delete ✓     │ │    delete ✓     │ │                │
      └────────────────┘ └────────────────┘ └────────────────┘

  ★ ordinary members can always READ (list/inspect) the organization's
    role definitions, even though they can grant nothing — a
    deliberately narrow, read-only exception carved out of an otherwise
    empty statement set.

  `creatorRole` (default "owner") is a distinguished role name, not a
  distinct statements object — it identifies whichever role the
  organization's CREATOR was granted, and several endpoints (§5, §7)
  treat the holder of that specific role name specially regardless of
  what its statements say (see the "creator bypass" in §4).
```

The `apiKey` resource used by the API-key package's organization
integration (`04-api-key-plugin.md`) is **not** part of this default
universe — it only becomes checkable once a deployer extends the universe
per `01-access-control.md §3` to include it (a concrete instance of "the
extension is additive, and existing roles must be re-authored to use it").

---

## 4. The organization-scoped permission-check contract

```
Operation:  hasPermission (organization variant)
Arrow shape: {
               role: string,               (comma-joined role names)
               options: OrganizationOptions,
               permissions: PermissionRequest,   (01-access-control.md §2)
               organizationId: string,
               allowCreatorAllPermissions?: boolean,
               useMemoryCache?: boolean,
             } -> Promise<boolean>

Requires:  `role` is the CALLER's Member.role for `organizationId` — the
           caller must already have been established as a member before
           this is ever invoked (every endpoint below performs a
           Member lookup first and treats "no Member row" as a distinct,
           earlier failure — see §5).

Ensures:
  1. Resolve the set of Role objects to check: `options.roles` (a
     deployer-supplied custom role map) merged over the plugin's default
     roles (§3), by role name.
  2. If `options.dynamicAccessControl.enabled` and an `ac` instance is
     configured (and the caller did not opt out via `useMemoryCache`
     reusing an already-resolved set from earlier in the same request):
     load every OrganizationRole row for `organizationId` from storage,
     and for each, MERGE its stored permission map into any
     same-named role already resolved in step 1 — merge is additive,
     per resource, as a set-union of granted actions (a dynamic role
     never narrows a same-named static role, only extends it, or
     defines an entirely new role name if there is no collision).
  3. Split `role` on "," (an actor may hold multiple role names in one
     organization, exactly as in the admin plugin). If
     `allowCreatorAllPermissions` is true AND one of the held role names
     equals `options.creatorRole` (default "owner"): return true
     UNCONDITIONALLY — the creator-role bypass (see below), independent
     of any statement.
  4. Otherwise, for each held role name, resolve it to a Role value from
     step 1/2 and delegate to `authorize(permissions)` per
     `01-access-control.md §2`. Return true if ANY held role authorizes.

Invariant:
  - The creator-role bypass is OPT-IN per call site, not global: only
    specific call sites set `allowCreatorAllPermissions: true`
    (`updateMemberRole`, and the API-key package's organization
    integration in `04-api-key-plugin.md`) — most organization-scoped
    checks in this document do NOT set it, meaning even a creatorRole
    holder is checked against its actual granted statements for most
    operations (the default `owner` role happens to be granted nearly
    everything, but that is a statement-level fact, not a bypass).
  - The dynamic-role merge (step 2) is resolved fresh on every call
    UNLESS the caller explicitly opts into `useMemoryCache`, which
    reuses a process-local cache keyed by `organizationId` populated by
    the most recent uncached resolution for that organization. This is
    an explicit, caller-chosen staleness tradeoff for call sites that
    perform many permission checks in a tight loop within one request
    (e.g. validating every resource/action pair of a role being created
    — see §7) — it is never the default.
```

```
             SEQUENCE: an organization-scoped authorization check
   client          org endpoint         adapter          hasPermission        access.ts
     │                  │                  │                    │                 │
     │ POST /organization/update           │                    │                 │
     ├─────────────────▶│                  │                    │                 │
     │                  │ resolve session   │                    │                 │
     │                  │ (orgSessionMiddleware)                 │                 │
     │                  │──findMemberByOrgId(user,org)──────────▶│                 │
     │                  │◀── Member{role} or null ────────────────┤                 │
     │            null? │                  │                    │                 │
     │◀── 400 not-a-member ─┤              │                    │                 │
     │            found  │                  │                    │                 │
     │                  │  hasPermission({role, options,        │                 │
     │                  │   permissions:{organization:[update]},│                 │
     │                  │   organizationId}) ───────────────────▶│                 │
     │                  │                  │  dynamicAC enabled? │                 │
     │                  │                  │◀─findMany(organizationRole)           │
     │                  │                  │  merge into role set                  │
     │                  │                  │  for each held role: ─────────────────▶│
     │                  │                  │                    │  authorize(req)  │
     │                  │                  │◀───────────────────┼─────────────────┤
     │                  │◀─────────────────┴────boolean──────────┤                 │
     │           false  │                  │                    │                 │
     │◀── 403 FORBIDDEN ─┤                  │                    │                 │
     │            true  │  perform update, run hooks, return    │                 │
     │◀── 200 ───────────┤                  │                    │                 │
```

---

## 5. Membership contract

```
Operation:  addMember (server-only — no HTTP route, no session/
            permission check of its own; the caller is fully
            responsible for authorizing the request before calling it)
Requires:   target user exists; target is not already a member of the
            organization (checked by email); if a teamId is given, that
            team belongs to the organization; the organization's
            membership limit (a number, or an async predicate over
            {user, organization}, default 100) is not yet reached.
Ensures:    a Member row is created with the requested role(s).

Operation:  removeMember
Requires:   caller is a member of the organization; caller authorized
            for member:delete; if the member being removed holds the
            `creatorRole`, the ORGANIZATION must retain at least one
            OTHER member holding that role after removal — the "last
            owner" invariant (checked twice: once against the acting
            member's own role composition, once by counting all
            creator-role holders in the organization).
Ensures:    the Member row is deleted; if the removed member is the
            CALLER and the organization being left is the session's
            currently active one, the session's activeOrganizationId is
            cleared as part of the same operation (see §6) — a session
            is never left pointing at an organization the caller no
            longer belongs to.
Invariant (last-owner invariant): an organization can never reach a
            state, through this endpoint, where zero members hold the
            creatorRole. (The plugin does not prevent this state from
            ever arising by other means — e.g. an admin-plugin-style
            direct database mutation — it only prevents THIS endpoint
            from producing it.)

Operation:  leaveOrganization
Requires:   caller has a Member row for the organization; same
            last-owner invariant as removeMember when the caller
            themself holds the creatorRole.
Ensures:    identical to removeMember, self-targeted; also clears the
            session's active-organization pointer if it was this one.

Operation:  updateMemberRole
Requires:   caller is a member; the target member belongs to the SAME
            organization as resolved from the request; every requested
            role name resolves to either a known static role or (with
            dynamic AC enabled) an existing per-organization dynamic
            role — otherwise ROLE_NOT_FOUND.
            Special creator-role rules, checked BEFORE the general
            permission check:
              - only a current creatorRole holder may update a member
                who already holds the creatorRole, or grant the
                creatorRole to anyone;
              - a creatorRole holder updating THEIR OWN role must
                either keep the creatorRole in the new role set, or
                leave at least one OTHER creatorRole holder in the
                organization (the last-owner invariant, phrased as a
                self-demotion guard here).
            The general check is then `hasPermission` for
            member:update, WITH `allowCreatorAllPermissions: true` —
            i.e. this is the one membership operation where the
            creator-role bypass (§4) applies, on top of the
            creator-specific rules above.
Ensures:    the target Member's role is replaced with the new,
            validated role set.
```

---

## 6. Active-organization / active-team session-scoping contract

```
Schema extension (cross-reference 00-methodology/01 §5 — this is an
ADDITIVE extension of the core session entity, not a narrowing of
anything the core session contract already promised):
   session.activeOrganizationId : string | null
   session.activeTeamId         : string | null   (only when
                                                     teams.enabled)

Invariant (the scoping invariant): whenever `activeOrganizationId` is
non-null, it MUST name an organization the session's user is currently
a member of. This is actively defended, not merely assumed: every
read path that resolves "the organization" from the active pointer
(getOrganization, getFullOrganization, setActiveOrganization itself)
re-checks membership at read time and, on finding the caller is no
longer a member (e.g. removed concurrently by someone else), CLEARS
activeOrganizationId to null as a side effect of the SAME call that
then reports FORBIDDEN/NOT_FOUND — the session is self-healing: it is
never left pointing at an organization the caller can no longer read.

Operation:  setActiveOrganization
Requires:   `organizationId` null (explicit clear) OR the caller is a
            current member of it (resolved by id or by slug).
Ensures:    session.activeOrganizationId is persisted and the session
            cookie is refreshed to reflect it in the same response.
On violation: FORBIDDEN if the caller is not a member (and, per the
            self-healing invariant above, the pointer is cleared to
            null as part of reporting the failure, not left stale).

Operation:  setActiveTeam
Requires:   an active organization must already be set on the session;
            the target team must belong to that active organization;
            the caller must be a TeamMember of it.
Ensures:    session.activeTeamId is persisted and the cookie refreshed.

Fallback contract, used throughout every organization-scoped endpoint
that accepts an optional `organizationId` parameter: when omitted, the
operation falls back to `session.activeOrganizationId`; if that is also
absent, the precondition fails (NO_ACTIVE_ORGANIZATION /
ORGANIZATION_NOT_FOUND — blamed CLIENT: the caller must either have an
active organization or supply one explicitly).
```

---

## 7. Invitation flow

```
                       INVITATION STATE MACHINE
                                                     (expiresAt elapses)
        ┌──────────────────────────────────────────────┐
        │                                                │
        ▼                                                │
  ┌───────────┐   acceptInvitation    ┌───────────┐      │
  │  pending   │──────────────────────▶│ accepted   │      │
  │            │  (guarded, single-    └───────────┘      │
  │            │   winner transition)       │              │
  │            │                             │ (compensating
  │            │◀────────────────────────────┘  release on
  │            │   membership-creation failure  failure)
  │            │   after the claim
  │            │
  │            │──rejectInvitation────▶┌───────────┐
  │            │                        │ rejected   │
  │            │                        └───────────┘
  │            │
  │            │──cancelInvitation────▶┌───────────┐
  │            │                        │ canceled   │
  │            │                        └───────────┘
  │            │
  │            │──createInvitation with resend=true or
  │            │  cancelPendingInvitationsOnReInvite──▶ (superseded: either
  └────────────┘                                        its expiry is
        ▲                                                refreshed in place,
        │  createInvitation (new)                        or it is moved to
        └────────────────────────────────────────────────canceled and a
                                                           fresh pending
                                                           invitation is
                                                           created)
```

```
Operation:  createInvitation
Requires:   caller is a member with invitation:create; every requested
            role resolves to a known static role or existing dynamic
            role; the caller may only invite someone INTO the
            creatorRole if the caller THEMSELF currently holds it;
            invitee is not already a member and (unless resend or
            cancel-and-reinvite is configured) does not already have a
            pending invitation; the organization's invitation-count
            limit (number or async function) is not exceeded; every
            named team belongs to this organization and, if a per-team
            member cap is configured, is not already at capacity.
Ensures:    a new pending Invitation is created with an expiry (default
            48 hours, configurable) — OR, if resending, the SAME
            invitation id has its expiry refreshed in place rather than
            a new row being created; email dispatch (if configured) is
            a best-effort side channel, not part of this operation's
            transactional postcondition — its failure does not roll
            back the created invitation.

Operation:  acceptInvitation
Requires:   caller is authenticated; the invitation exists, is still
            `pending`, and has not expired; the caller's OWN email
            matches the invitation's email exactly (case-insensitive)
            — an invitation is bound to an email identity, never
            transferable to a different signed-in account.
            Conditional additional precondition — verified-email proof:
            when the deployment's invitation-id generation is anything
            other than the default opaque/unguessable form (or the
            deployer has explicitly required it), the caller's email
            must ALSO be verified before the invitation is honored.
            Rationale, stated as a contract rather than a mechanism: an
            unguessable invitation id is treated as sufficient proof
            that the caller obtained it by reading the invited mailbox;
            anything that weakens that unguessability (a sequential or
            otherwise enumerable id) removes that proof, and a verified
            email address becomes the substitute proof requirement.
            The organization's membership limit must not already be
            reached.
Ensures (all-or-nothing, saga-style): the invitation is atomically
            claimed via a single guarded pending->accepted transition
            (so two concurrent accept calls cannot both succeed); if
            every subsequent step (team membership, org membership,
            active-organization assignment) completes, the postcondition
            is: a Member row exists for the caller in the invitation's
            organization, any single named team gained the caller as
            a TeamMember and became the session's active team, and the
            session's active organization is set to this one. If ANY
            step after the claim fails, the claim is released back to
            `pending` (a compensating action) rather than leaving the
            invitation stranded as `accepted` with no corresponding
            membership — the invitee can simply retry.
Invariant:  an invitation can never be observed, by any reader, in a
            state of "accepted but no member exists for it" that
            persists past the failed call that produced it.

Operation:  rejectInvitation / getInvitation
Requires:   invitation exists and is pending (reject) or pending and
            unexpired (get); caller's own email matches the
            invitation's email; same conditional verified-email
            requirement as acceptInvitation.
Ensures:    reject transitions the invitation to `rejected`; get is
            read-only and additionally surfaces the inviting
            organization's name/slug and the inviter's email.

Operation:  cancelInvitation
Requires:   caller is a member of the invitation's organization,
            authorized for invitation:cancel.
Ensures:    the invitation transitions to `canceled`.

Operation:  listInvitations / listUserInvitations
Requires:   listInvitations requires the caller be a member of the
            target organization (any member may list — no additional
            statement is required beyond membership itself).
            listUserInvitations, called WITH a session, requires the
            session's email to be verified before enumerating
            invitations addressed to it (the session-carried email is
            trusted as the identity being queried, but only once
            proven); called WITHOUT a session (a trusted server-side
            caller passing an explicit email) skips this gate, since
            the caller is not asserting an unproven identity on its
            own behalf.
Ensures:    listUserInvitations returns only `pending` invitations.
```

---

## 8. Team contract (only when `teams.enabled`)

```
Operation:  createTeam
Requires:   an active (or explicit) organization; if called with a
            session, member with team:create; the organization's
            maximum-teams limit (number or function) is not exceeded.
            (A server-side, sessionless call skips the membership/
            permission check, mirroring `addMember`'s trust model.)
Ensures:    a new Team row is created; organization-creation itself may
            auto-create a default team (configurable, on by default)
            and enroll the creator as its first TeamMember.

Operation:  updateTeam / removeTeam
Requires:   member with team:update / team:delete respectively; for
            removeTeam, the team must not be the caller's own active
            team, and (unless `allowRemovingAllTeams` is set) it must
            not be the organization's LAST remaining team.
Ensures:    removeTeam also strips the removed team's id out of every
            pending invitation that named it — an invitation degrades
            to an organization-level (team-less) invitation rather than
            referencing a team that no longer exists.

Operation:  addTeamMember / removeTeamMember
Requires:   caller is a member of the organization, authorized for
            member:update / member:delete respectively — NOT a
            team-resource permission. This is a deliberate, cross-
            resource mapping: changing a team's ROSTER is governed by
            the same permission that governs organization membership
            changes, while changing a team's METADATA (name, etc.) is
            governed by the `team` resource (updateTeam/removeTeam,
            above). The two are not the same statement.
            If a per-team member cap is configured, adding must not
            exceed it.
Ensures:    a TeamMember row is created/deleted.

Operation:  listUserTeams
Requires:   self-query (no target userId given): none beyond having a
            session; querying ANOTHER user's teams requires the caller
            be a member of the (explicit or active) organization AND
            hold member:update there — listing another member's team
            affiliations is treated as a membership-management
            capability, not a plain read.
Ensures:    a self-query without an explicit organizationId returns
            teams across every organization the caller actually
            belongs to (a stray TeamMember row pointing at an
            organization the caller has since left is never surfaced).
```

---

## 9. Dynamic access control — extending the primitive per organization

This is the organization plugin's own instantiation of the extension
mechanism from `01-access-control.md §3`, made *runtime*, *per
organization*, and *self-service* (subject to permission) rather than a
one-time, deploy-time universe replacement.

```
Requires (of the FEATURE as a whole): a deployer-configured `ac`
  instance (`01-access-control.md`'s `createAccessControl(...)` result)
  must be supplied via `options.ac` before ANY dynamic-role endpoint can
  be used — there is no default universe for dynamic roles to validate
  resource names against otherwise. Its absence is a deployment
  misconfiguration, not a per-request condition.
  Blamed party: SUPPLIER (the deployer), surfaced as a distinct,
  loudly-logged error rather than a routine 403.

Operation:  createOrgRole
Requires:   caller is a member, authorized for ac:create; the role name
            (case-insensitive) collides with neither a pre-defined
            static role name nor an existing dynamic role name in this
            organization; EVERY resource key named in the requested
            permission map is a resource actually declared in the
            deployer's `ac.statements` universe (unknown-resource
            rejection — the one place in this tree where a
            resource-universe check IS enforced at runtime, not merely
            by the type system, per `01-access-control.md §1.1`); the
            organization's role-count ceiling
            (`dynamicAccessControl.maximumRolesPerOrganization`, default
            unbounded) is not exceeded.
            SELF-ESCALATION GUARD (a Liskov-style narrowing rule,
            structurally the same shape as the one specified for API
            key permissions in `04-api-key-plugin.md §4`): for every
            single resource/action pair named in the requested
            permission map, the CALLER's own current, effective
            organization permissions must already authorize that exact
            pair — an actor can only mint a new role that is a subset
            of what they themselves can already do. This is checked
            action-by-action (not merely resource-by-resource), and
            uses the SAME `hasPermission`/`authorize` machinery as any
            other check in this document, just invoked once per
            requested pair.
Ensures:    a new OrganizationRole row is persisted, storing the role
            name and its permission map; from this point on it is
            assignable to members and invitations by name, and it is
            merged (additively, per §4 step 2) into `hasPermission`
            resolution for this organization on every subsequent check.

Operation:  updateOrgRole
Requires:   caller authorized for ac:update; if the permission map is
            being changed, the SAME unknown-resource check and the SAME
            self-escalation guard as createOrgRole apply to the NEW
            map; if the role's name is being changed, the new name must
            clear the same collision checks as at creation.
Ensures:    the role's stored permission map and/or name are replaced.

Operation:  deleteOrgRole
Requires:   caller authorized for ac:delete; the role must not be a
            pre-defined static role name (those cannot be deleted
            through this path at all); the role must not currently be
            held by any Member of the organization (members must be
            reassigned first — a role can never be deleted out from
            under an actor currently holding it).
Ensures:    the OrganizationRole row is removed; it is no longer
            assignable, and — since no member could hold it (the
            precondition above) — no in-flight permission check can be
            silently invalidated by its removal.

Operation:  listOrgRoles / getOrgRole
Requires:   caller authorized for ac:read.
Ensures:    read-only.
```

---

## 10. Extension points: organization hooks

`organizationHooks` (before-*/after-* callbacks for organization, member,
invitation, team, and team-member create/update/delete) are higher-order
arrow contracts in the sense of `00-methodology/02-higher-order-contracts.md`
— specified there, not re-derived here. In this plugin's usage:

```
before-*  :  OperationInput  ->  { }  |  { data: OverrideFields }  |  throws

  A "before" hook may return a `data` object whose fields are merged
  OVER the operation's own computed defaults before persistence (a
  staged/dependent contract: the endpoint's default data is the domain,
  the hook's override is the range), or throw to abort the operation
  entirely before any write occurs. It runs strictly after this
  document's own authorization checks — a hook can veto or reshape data
  for an ALREADY-authorized call, but it is never itself a substitute
  for the permission checks specified above, and it cannot be used to
  bypass them.

after-*   :  OperationResult  ->  void

  Pure notification, run only once the operation's own postcondition
  already holds (the entity has already been created/updated/deleted).
  It cannot veto or modify the result.
```
