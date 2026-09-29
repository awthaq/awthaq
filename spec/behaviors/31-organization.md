# Organization
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-31 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (implementing [MOD-EA-014](../models/14-organization.md) as `@awthaq/organization`; MTI-011) |
---

> `@awthaq/organization` composes as `Auth.make([Organization])` and serves the `organization` HTTP group at `/organization/...`, all behind `Api.Authentication` and `Api.CsrfProtection`. It is the multi-tenant membership plugin ([MOD-EA-014](../models/14-organization.md)): the behaviors below are what an application relies on to treat an organization as a tenant boundary. Roles and statements are the plugin's own `PermissionEngine` ([ADR-EA-025](../decisions/025-global-roles-vs-organization-roles.md)), never a qadi round trip; tenancy resolution and tenant-stamped rows are [BEH-EA-230](28-tenancy.md#beh-ea-230-the-tenant-is-an-ambient-reference-that-defaults-to-none) through [BEH-EA-237](28-tenancy.md#beh-ea-237-a-suspended-organization-refuses-organization-scoped-access), and the qadi relationship grammar is [BEH-EA-162](21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership).

## BEH-EA-258: An organization has a unique slug, its creator becomes its first member, and creating one is bounded by policy and quota

```text
REQUIREMENT: `POST /organization` MUST create the organization and make the
             caller its first member holding `OrganizationConfig.creatorRole`
             (default `owner`). A slug already held by any organization MUST be
             refused `409`, and `GET /organization/check-slug` MUST report whether
             a slug is free. A caller for whom `allowUserToCreateOrganization`
             answers `false` MUST be refused `403`, and a caller who already owns
             `organizationLimit` organizations (default 10; `Infinity` opts out)
             MUST be refused `403` before any organization or membership is
             written. `GET /organization` MUST list only the organizations the
             caller belongs to.
```

The creator's membership and the organization are written together, so there is never an organization nobody belongs to. The finite default quota exists so an open sign-up cannot mint unbounded tenants; a deployment that wants that opts out explicitly.

_Previous: [BEH-EA-253](30-scim.md#beh-ea-253-provisioning-lifecycle-changes-are-published-as-events) | Next: [BEH-EA-259](31-organization.md#beh-ea-259-organization-data-is-member-only-and-a-non-member-cannot-tell-an-organization-that-exists-from-one-that-does-not)_

## BEH-EA-259: Organization data is member-only, and a non-member cannot tell an organization that exists from one that does not

```text
REQUIREMENT: Every `/organization/:organizationId/...` endpoint MUST answer
             a caller who is not a member of `organizationId` with `404`, byte-for-byte
             the same response it gives for an id that names no organization.
             This MUST hold for reads, writes, members, invitations, roles and teams
             alike; a team, role, invitation or membership that belongs to another
             organization MUST be `404` even when the caller is a member (or owner)
             of the organization named in the path. Only a member who lacks the
             statement an operation needs MAY see `403`. The answer to a non-member
             MUST NOT depend on which optional features are enabled: with teams
             disabled, a team endpoint still answers `404`, not `403`. An
             invitation, and any active-context change, MUST NOT be reachable by
             naming its id from an organization or a session it does not belong to.
```

This is the tenant boundary at the HTTP surface: a `403` would confirm the organization exists, so the plugin spends it only on people who are already inside. Every scenario for this rule is adversarial by construction: a fully authenticated caller from tenant A aims at tenant B's identifiers and must learn nothing and change nothing. Cross-tenant ids inside a path (a team of B under A's id) are the classic confused-deputy shape and are refused by scoping every lookup to the organization in the path.

_Previous: [BEH-EA-258](31-organization.md#beh-ea-258-an-organization-has-a-unique-slug-its-creator-becomes-its-first-member-and-creating-one-is-bounded-by-policy-and-quota) | Next: [BEH-EA-260](31-organization.md#beh-ea-260-an-organization-always-keeps-an-owner-and-only-an-owner-may-delete-it)_

## BEH-EA-260: An organization always keeps an owner, and only an owner may delete it

```text
REQUIREMENT: An operation that would leave an organization with no member
             holding `owner` MUST be refused `409`: removing the last owner,
             changing the last owner's role away from `owner`, or the last
             owner leaving. With a second owner present each of these MUST
             succeed. Only an owner MAY delete the organization (`204`); an `admin`
             MUST be refused `403`. Deleting MUST remove the organization's
             memberships, invitations, teams and roles, after which its id MUST
             answer `404` to everyone. `disableOrganizationDeletion` MUST refuse
             deletion for every caller, owner included.
```

The invariant is checked where the roles are read, not where the request arrives, so `leave`, `removeMember` and `updateMemberRole` cannot disagree about what "last owner" means.

_Previous: [BEH-EA-259](31-organization.md#beh-ea-259-organization-data-is-member-only-and-a-non-member-cannot-tell-an-organization-that-exists-from-one-that-does-not) | Next: [BEH-EA-261](31-organization.md#beh-ea-261-an-invitation-is-an-emailed-capability-for-one-address-with-its-own-lifecycle)_

## BEH-EA-261: An invitation is an emailed capability for one address, with its own lifecycle

```text
REQUIREMENT: An invitation MUST be mailed to its address with a random
             token of which only the SHA-256 is stored; neither the token nor its
             hash MUST appear in any API response. Accepting or rejecting MUST
             need the emailed token: an unknown invitation id and a wrong token
             MUST be indistinguishable (`404`). Only a user who owns the invited
             address MAY accept (`403` otherwise), and by default only with a
             verified address (`requireEmailVerificationOnInvitation`, `403`).
             An invitation past `invitationExpiresIn` MUST be refused `410` and
             marked expired. A canceled, rejected or accepted invitation MUST
             NOT be accepted again (`409`). Inviting an address that already
             belongs to a member MUST be refused `409`. Re-inviting a pending
             address MUST NOT create a second pending invitation: it returns
             the pending one, or (`cancelPendingInvitationsOnReInvite`)
             cancels it and issues a fresh one, or (`resend: true`) mints a
             new token for it and retires the mailed one.
```

The token is a capability, so it is treated like the verification tokens of [BEH-EA-060](08-verification-tokens.md#beh-ea-060-a-verification-token-is-hashed-at-rest): hashed at rest, compared in constant time, and never echoed. Binding acceptance to the invited address as well means a forwarded mail does not confer membership on whoever received it.

_Previous: [BEH-EA-260](31-organization.md#beh-ea-260-an-organization-always-keeps-an-owner-and-only-an-owner-may-delete-it) | Next: [BEH-EA-262](31-organization.md#beh-ea-262-membership-invitation-and-team-quotas-are-enforced-per-organization)_

## BEH-EA-262: Membership, invitation and team quotas are enforced per organization

```text
REQUIREMENT: The plugin MUST refuse an addition that would exceed a limit
             (`403`): a member beyond `membershipLimit`, an invitation beyond
             `invitationLimit` per inviter, a team beyond `teams.maximumTeams`,
             a team member beyond `teams.maximumMembersPerTeam`. A limit reached
             at accept time MUST leave the invitation pending and the roster
             unchanged. `limitsFor(organizationId)` MUST be consulted at decision
             time and its values MUST override the static ones for that
             organization only, so a plan tier changes without redeploying.
```

Limits are checked against the stored count at the moment of the write, not cached at configuration time, which is what lets a per-organization override take effect on the next request.

_Previous: [BEH-EA-261](31-organization.md#beh-ea-261-an-invitation-is-an-emailed-capability-for-one-address-with-its-own-lifecycle) | Next: [BEH-EA-263](31-organization.md#beh-ea-263-a-role-can-only-be-conferred-by-someone-who-holds-everything-it-grants)_

## BEH-EA-263: A role can only be conferred by someone who holds everything it grants

```text
REQUIREMENT: Every path that assigns roles (`invite`, `updateMemberRole`,
             creating or updating a dynamic role) MUST be bounded by
             `PermissionEngine.canGrant`: a caller MUST NOT confer, and MUST NOT
             change the role of a member who holds, statements the caller does not
             hold. An `admin` therefore cannot mint or promote an `owner`, and a
             `member` (who holds no mutating statement) cannot invite at all
             (`403`). A role name that is neither built in, configured nor a
             stored dynamic role MUST be refused `422`. The names `owner`,
             `admin` and `member` and every configured static role name are
             reserved: a dynamic role MUST NOT take one (`409`). A dynamic role
             whose statements exceed the creator's own MUST be refused `403`.
```

Without the guard, any holder of `member:update` could promote themselves: the endpoint that edits roles would be the privilege-escalation path. The guard is the discretionary-access-control rule "you cannot give what you do not have", applied uniformly rather than per endpoint.

_Previous: [BEH-EA-262](31-organization.md#beh-ea-262-membership-invitation-and-team-quotas-are-enforced-per-organization) | Next: [BEH-EA-264](31-organization.md#beh-ea-264-the-active-organization-is-per-session-requires-membership-and-never-outlives-it)_

## BEH-EA-264: The active organization is per session, requires membership, and never outlives it

```text
REQUIREMENT: `POST /organization/active` MUST record the active organization
             for the calling session only and MUST require membership (`404`
             otherwise, the same answer as an unknown id). `GET /organization/active`
             MUST return it, and `null` clears it. Two sessions of one user MUST
             hold independent active organizations. Once the user is no longer a
             member (removed, or left) the active context MUST read as cleared and
             MUST be cleared, never resurrected by a later re-read.
```

The active organization is a convenience pointer, never an authority: every request is still authorized against the caller's membership, so a stale pointer could at worst mislead a UI. It is re-validated on read so it cannot.

_Previous: [BEH-EA-263](31-organization.md#beh-ea-263-a-role-can-only-be-conferred-by-someone-who-holds-everything-it-grants) | Next: [BEH-EA-265](31-organization.md#beh-ea-265-organization-changes-are-published-as-events-and-a-hook-can-veto-them)_

## BEH-EA-265: Organization changes are published as events, and a hook can veto them

```text
REQUIREMENT: Creating an invitation, adding a member (by accepting an
             invitation) and removing a member MUST each publish their
             `auth.organization.*` event once, ids only, into `AuthEvents`. Each
             mutating operation has a `veto` hook point run before it (an abort
             surfaces as the typed `HookAborted`, `403`, with nothing written) and
             an `observe` hook point run after it, whose failure never changes
             the operation's outcome ([BEH-EA-090](12-hooks.md#beh-ea-090-a-veto-tap-may-abort-the-operation-with-a-typed-hookabort) and [BEH-EA-092](12-hooks.md#beh-ea-092-an-observe-tap-is-fail-isolated--a-throwing-observer-cannot-fail-the-operation-it-observes)).
             Erasing an account MUST remove its memberships, team memberships,
             invitations and active-context rows in the same transaction.
```

Events carry identifiers only so the audit trail names who was added or removed without becoming a second copy of personal data; the erasure clause is the organization plugin's contribution to the erasure registry ([BEH-EA-254](06-domain-users-accounts.md#beh-ea-254-a-person-can-export-everything-the-system-holds-about-them-as-one-document-and-no-plugin-can-be-left-out) is its export-side mirror).

_Previous: [BEH-EA-264](31-organization.md#beh-ea-264-the-active-organization-is-per-session-requires-membership-and-never-outlives-it)_
