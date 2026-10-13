# Organization
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-35 |
> | Revision | 1.3 |
> | Effective Date | 2026-10-13 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (implementing [MOD-EA-014](../models/14-organization.md) as `@awthaq/organization`; MTI-011) <br> 1.1 (2026-10-13): BEH-EA-284: the records are Keyed by organization id, every cross-organization method takes a witness, and the stores fail with StoreUnavailable (plan 05 phase 6) <br> 1.2 (2026-10-13): BEH-EA-330, organization state is reached through system modules that take an actor (ADR-EA-040, architecture plan 04 phase 1) <br> 1.3 (2026-10-13): BEH-EA-288: one `Bound` for every role-conferring path, `Unbounded` an explicit choice; membership is `OrganizationMembers` (add, setRoles, remove), so a directory's and an identity provider's changes run the same limit, owner invariant, veto, cascade and observers as a member's; the statement check now precedes the owner invariant (D4) and an unchanged role set is a no-op everywhere (D5) (ADR-EA-040, architecture plan 04 phase 3) |
---

> `@awthaq/organization` composes as `Auth.make([Organization])` and serves the `organization` HTTP group at `/organization/...`, all behind `Api.Authentication` and `Api.CsrfProtection`. It is the multi-tenant membership plugin ([MOD-EA-014](../models/14-organization.md)): the behaviors below are what an application relies on to treat an organization as a tenant boundary. Roles and statements are the plugin's own `PermissionEngine` ([ADR-EA-025](../decisions/025-global-roles-vs-organization-roles.md)), never a qadi round trip; tenancy resolution and tenant-stamped rows are [BEH-EA-230](28-tenancy.md#beh-ea-230-the-tenant-is-an-ambient-reference-that-defaults-to-none) through [BEH-EA-237](28-tenancy.md#beh-ea-237-a-suspended-organization-refuses-organization-scoped-access), and the qadi relationship grammar is [BEH-EA-162](21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership).

## BEH-EA-283: An organization has a unique slug, its creator becomes its first member, and creating one is bounded by policy and quota

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

_Previous: [BEH-EA-253](30-scim.md#beh-ea-253-provisioning-lifecycle-changes-are-published-as-events) | Next: [BEH-EA-284](35-organization.md#beh-ea-284-organization-data-is-member-only-and-a-non-member-cannot-tell-an-organization-that-exists-from-one-that-does-not)_

## BEH-EA-284: Organization data is member-only, and a non-member cannot tell an organization that exists from one that does not

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

Implementation (plan 05): the organization tables are Keyed ([BEH-EA-328](28-tenancy.md#beh-ea-328-every-plugin-table-declares-its-tenancy-and-authmake-validates-the-declarations)): every records method takes the organization id it is scoped by, an update of an invitation, a connection's domains and a team's member count included, so a statement that names only another table's key cannot reach another organization's row. A method that must read or erase across organizations (a caller's own memberships, the platform listing and suspension, home-realm discovery, the invitation id or emailed token as capability, the invitee's and inviter's own invitations, the per-inviter quota, the erasure and export sweeps) takes a `TenantScoped.CrossTenant` witness minted next to the call with the reason it is sound ([BEH-EA-327](28-tenancy.md#beh-ea-327-a-cross-tenant-statement-presents-a-witness-and-the-witness-lifts-rls)); `TestAuth.runTenantIsolationTests` classifies every method of every records interface, which replaces the static allowlist that used to pin this. A connection's client secret is a sealed column of `ConnectionRecords` ([ADR-EA-019](../decisions/019-encryption-key-rotation.md) decision 6). A store outage is `StoreUnavailable` ([BEH-EA-325](05-persistence-stratum.md#beh-ea-325-a-plugin-records-module-fails-with-storeunavailable-never-a-defect-when-its-store-is-down)), never a defect; the tenant middleware answers it `503`.

_Previous: [BEH-EA-283](35-organization.md#beh-ea-283-an-organization-has-a-unique-slug-its-creator-becomes-its-first-member-and-creating-one-is-bounded-by-policy-and-quota) | Next: [BEH-EA-285](35-organization.md#beh-ea-285-an-organization-always-keeps-an-owner-and-only-an-owner-may-delete-it)_

## BEH-EA-285: An organization always keeps an owner, and only an owner may delete it

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

_Previous: [BEH-EA-284](35-organization.md#beh-ea-284-organization-data-is-member-only-and-a-non-member-cannot-tell-an-organization-that-exists-from-one-that-does-not) | Next: [BEH-EA-286](35-organization.md#beh-ea-286-an-invitation-is-an-emailed-capability-for-one-address-with-its-own-lifecycle)_

## BEH-EA-286: An invitation is an emailed capability for one address, with its own lifecycle

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

_Previous: [BEH-EA-285](35-organization.md#beh-ea-285-an-organization-always-keeps-an-owner-and-only-an-owner-may-delete-it) | Next: [BEH-EA-287](35-organization.md#beh-ea-287-membership-invitation-and-team-quotas-are-enforced-per-organization)_

## BEH-EA-287: Membership, invitation and team quotas are enforced per organization

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

_Previous: [BEH-EA-286](35-organization.md#beh-ea-286-an-invitation-is-an-emailed-capability-for-one-address-with-its-own-lifecycle) | Next: [BEH-EA-288](35-organization.md#beh-ea-288-a-role-can-only-be-conferred-by-someone-who-holds-everything-it-grants)_

## BEH-EA-288: A role can only be conferred by someone who holds everything it grants

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
             The bound is one value, `Bound`: a `Ceiling` of the statements the
             source holds (the caller's, a SAML connection's role ceiling) or the
             explicit `Unbounded` of a trusted source (SCIM's configured member
             role, application code). A veto tap that rewrites the roles is
             bounded on what is stored.
```

Without the guard, any holder of `member:update` could promote themselves: the endpoint that edits roles would be the privilege-escalation path. The guard is the discretionary-access-control rule "you cannot give what you do not have", applied uniformly rather than per endpoint.

_Previous: [BEH-EA-287](35-organization.md#beh-ea-287-membership-invitation-and-team-quotas-are-enforced-per-organization) | Next: [BEH-EA-289](35-organization.md#beh-ea-289-the-active-organization-is-per-session-requires-membership-and-never-outlives-it)_

## BEH-EA-289: The active organization is per session, requires membership, and never outlives it

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

_Previous: [BEH-EA-288](35-organization.md#beh-ea-288-a-role-can-only-be-conferred-by-someone-who-holds-everything-it-grants) | Next: [BEH-EA-290](35-organization.md#beh-ea-290-organization-changes-are-published-as-events-and-a-hook-can-veto-them)_

## BEH-EA-290: Organization changes are published as events, and a hook can veto them

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

## BEH-EA-330: Every caller reaches organization state through one system module per sub-domain, so its invariants, hooks and events cannot be skipped

```text
REQUIREMENT: A write to an `organization_*` table MUST go through exactly one
             method of one system module (`OrganizationTeams`, ...), whoever the
             caller: an HTTP member, a SCIM connection, an identity provider, a
             platform administrator or application code. That method MUST run its
             guards, then its veto point (an abort is the typed `HookAborted`, `403`,
             with nothing written), then its writes in one transaction, then
             publish its `auth.organization.*` events and run its observe point
             after the transaction ends. A system method takes an explicit `Actor`
             (`User`, `Directory`, `IdentityProvider`, `PlatformAdmin`,
             `Application`), which reaches every hook input, and never an
             `Api.UserPrincipal`. A role-conferring method takes a `Bound`: a
             `Ceiling` of the statements its source holds, or the explicit
             `Unbounded` of a trusted source. The authorized interface (`Organization`)
             MUST be only visibility, the feature gates, `PermissionEngine`
             statements with the denial audit event, and the derivation of that
             `Bound`.
```

The modules are exposed in `Organization.layer`'s `ROut` ([BEH-EA-329](02-plugin-composition-validate.md#beh-ea-329-a-plugin-may-expose-namespaced-domain-services-and-a-dependent-that-requires-one-must-list-the-exposer-in-dependson)), so another plugin requires them through the Layer type and lists `Organization` in `dependsOn`; none of them touches the records. This is what makes a veto policy, a quota, the last-team rule or a decision-cache invalidation hold for a directory sync as it does for a member, and what makes a platform suspension observable. `OrganizationAuthority` is the read-only module every gate, every `Bound` and `OrganizationQadi` read, so one evaluation path decides ([ADR-EA-009](../decisions/009-authorization-delegated-to-qadi.md)).

_Previous: [BEH-EA-289](35-organization.md#beh-ea-289-the-active-organization-is-per-session-requires-membership-and-never-outlives-it)_
