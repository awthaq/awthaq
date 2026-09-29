# SCIM Provisioning
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-30 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release, implementing [MOD-EA-012](../models/12-scim.md) as `@awthaq/scim` (CWM-002, AOMS-009; [ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) |
---

> `@awthaq/scim` composes as `Auth.make([Organization, Scim])` (`Scim` `dependsOn: [Organization]`), serves `/scim/v2` per RFC 7644, and stands on the user status of [BEH-EA-46](06-domain-users-accounts.md) and `Sessions.revokeAll`. Everything below is what a directory service (Okta, Entra ID, OneLogin) relies on, plus the safety rules that keep an organization's directory from reaching accounts it did not create.

## BEH-EA-246: A SCIM connection authenticates by a hashed, revocable bearer token and scopes everything it reads

```text
REQUIREMENT: Every `/scim/v2` request MUST carry `Authorization: Bearer
             <token>` where the token names one SCIM connection of one
             organization. Only the SHA-256 of the token MUST be stored (the
             token itself is returned once, at creation, `scim_` + 256 random
             bits), looked up by that hash and compared in constant time. An
             absent, malformed, unknown or revoked token, and the token of a
             connection whose organization is missing or suspended
             ([BEH-EA-237](28-tenancy.md)), MUST all answer the same 401. No
             cookie is ever trusted, which is why no CSRF check applies.
             Every resource lookup MUST be keyed by the calling connection: a
             token for connection A can neither read nor change connection B's
             users or groups.
```

The token is a bearer credential for a machine, so it is treated like one: hashed at rest (a database read discloses nothing an IdP could present), revocable without deleting what it provisioned, and never accepted in a way that distinguishes "wrong" from "revoked".

_Previous: [BEH-EA-245](29-saml-sp.md#beh-ea-245-the-nameid-links-to-an-account-through-the-connection-never-by-email-alone) | Next: [BEH-EA-247](30-scim.md#beh-ea-247-a-connection-acts-only-on-the-users-it-provisioned-and-never-adopts-an-existing-account)_

## BEH-EA-247: A connection acts only on the users it provisioned, and never adopts an existing account

```text
REQUIREMENT: `POST /Users` MUST create the user (an `Email` identity from the
             primary `emails` value or an address-shaped `userName`; otherwise an
             `Anonymous` identity — never a synthetic address), record it in the
             connection's ownership map (`scim_resource`) and add it to the
             connection's organization as a member. It MUST NOT adopt an existing
             account: an email already held by any user is `409 uniqueness`. A
             repeated `POST` with the same `externalId` MUST converge on the user
             it already provisioned. A failed provisioning (a full organization, a
             vetoed membership) MUST leave neither user nor mapping behind.
             `GET`/`PUT`/`PATCH`/`DELETE` and list MUST see only users that have
             a mapping for the calling connection; any other user id — another
             connection's, or one that was never provisioned — is `404`.
```

This is the rule that keeps SCIM safe on a global identity directory ([ADR-EA-018](../decisions/018-tenancy-is-an-organization.md) Decision 4): if a directory could name any user, one organization's token could claim, then deactivate, another organization's account by email.

_Previous: [BEH-EA-246](30-scim.md#beh-ea-246-a-scim-connection-authenticates-by-a-hashed-revocable-bearer-token-and-scopes-everything-it-reads) | Next: [BEH-EA-248](30-scim.md#beh-ea-248-username-is-immutable-and-the-other-attributes-update-per-put-and-patch)_

## BEH-EA-248: `userName` is immutable and the other attributes update per `PUT` and `PATCH`

```text
REQUIREMENT: A `PUT` or `PATCH` that would change a provisioned user's
             `userName` MUST be refused `400 mutability` (re-sending the same value,
             case-insensitively, is fine). `PUT` replaces `displayName`/`name`,
             `externalId` (an absent one clears it) and `active`. `PATCH` MUST accept
             `add`/`replace`/`remove` case-insensitively, with a `path` or with a
             path-less object of attributes (Okta), boolean values as JSON booleans
             or `"True"`/`"False"` (Entra), and MUST ignore attributes it does not
             manage rather than failing the sync. An unknown `op` is `400
             invalidSyntax`.
```

An IdP-driven email change would be an account-takeover path (change the address, then reset the password to it), so identity attributes are fixed at creation; everything else a directory legitimately maintains is writable.

_Previous: [BEH-EA-247](30-scim.md#beh-ea-247-a-connection-acts-only-on-the-users-it-provisioned-and-never-adopts-an-existing-account) | Next: [BEH-EA-249](30-scim.md#beh-ea-249-active-is-suspension-that-ends-every-session-and-only-its-own-suspension-is-lifted)_

## BEH-EA-249: `active` is suspension that ends every session, and only its own suspension is lifted

```text
REQUIREMENT: `active: false` MUST be `Users.setStatus(userId, "suspended")`
             followed by `Sessions.revokeAll(userId, "suspended")` — never a
             deletion — so already-issued sessions die at once and
             `Users.assertCanSignIn` refuses new ones. The suspension MUST be
             stamped with the connection (`statusReason = scim:<connectionId>`).
             `active: true` MUST reactivate only a suspension so stamped; an
             administrator's ban (any other reason) MUST stay in force, the
             resource then reporting `active: false`. Provisioning with
             `active: false` MUST create an already-suspended user, and a repeat
             `POST` for a deactivated user MUST reactivate it (a directory
             re-provision).
```

Offboarding is the case SCIM exists for: an application that leaves a terminated employee's sessions alive fails it. And a directory sync must never be able to undo a security decision made outside it.

_Previous: [BEH-EA-248](30-scim.md#beh-ea-248-username-is-immutable-and-the-other-attributes-update-per-put-and-patch) | Next: [BEH-EA-250](30-scim.md#beh-ea-250-delete-deactivates-by-default-and-erases-when-configured)_

## BEH-EA-250: `DELETE` deactivates by default and erases when configured

```text
REQUIREMENT: `DELETE /Users/:id` MUST, by default, behave as `active: false`
             (BEH-EA-249): the user, its accounts and history remain, and the
             resource stays readable as inactive. When `ScimConfig.deleteBehavior`
             is `"erase"`, it MUST revoke every session, remove the mapping and
             delete the user through `Users.delete` (so the `BeforeUserDelete`
             erasure taps run); the user's external id is then free to be
             provisioned again as a new user.
```

The two observable postconditions differ on purpose (a deleted user's row, accounts and history are gone), which is why erasure is opt-in.

_Previous: [BEH-EA-249](30-scim.md#beh-ea-249-active-is-suspension-that-ends-every-session-and-only-its-own-suspension-is-lifted) | Next: [BEH-EA-251](30-scim.md#beh-ea-251-groups-are-organization-teams-and-a-connection-only-changes-the-users-it-provisioned)_

## BEH-EA-251: Groups are organization teams, and a connection only changes the users it provisioned

```text
REQUIREMENT: A SCIM Group MUST be an organization team of the connection's
             organization, created, renamed, populated and removed through
             `/Groups`, and only groups the connection created (the mapping)
             MUST be visible to it. Members MUST be users the connection
             provisioned and that are organization members; a group body
             naming any other user is `400 invalidValue`. A `PUT`/`PATCH`
             member replacement MUST replace only the provisioned members of the
             team — other members of the team are never removed. `DELETE` of a
             group with child teams is `409`; a group whose team was removed
             elsewhere is `404` and its stale mapping is dropped.
```

Teams also have hierarchy and roles the SCIM model has no words for; the directory sees a flat group of the users it owns, and everything else about the team stays the organization's.

_Previous: [BEH-EA-250](30-scim.md#beh-ea-250-delete-deactivates-by-default-and-erases-when-configured) | Next: [BEH-EA-252](30-scim.md#beh-ea-252-the-wire-format-follows-rfc-7644-content-types-filters-paging-errors-and-discovery)_

## BEH-EA-252: The wire format follows RFC 7644: content types, filters, paging, errors and discovery

```text
REQUIREMENT: Responses MUST be `application/scim+json`; a request body MUST be
             accepted as `application/scim+json` or `application/json`. List
             endpoints MUST return a `ListResponse` (`totalResults`,
             `startIndex` 1-based, `itemsPerPage`, `Resources`), support
             `count` (0 allowed, bounded by `ScimConfig.maxResults`), and
             support exactly the filters `userName eq "…"` / `externalId eq "…"`
             (users) and `displayName eq "…"` / `externalId eq "…"` (groups); any
             other filter is `400 invalidFilter`. Errors MUST be the RFC 7644
             §3.12 body (`schemas`, `status` as a string, `scimType`, `detail`).
             `/ServiceProviderConfig`, `/ResourceTypes` and `/Schemas` MUST be
             served behind the same token and truthfully report PATCH and filter
             supported and bulk, sort, ETag and password change not.
```

Not supported, and reported as such: `/Bulk`, `sortBy`, `/Me`, ETag concurrency and compound filters.

_Previous: [BEH-EA-251](30-scim.md#beh-ea-251-groups-are-organization-teams-and-a-connection-only-changes-the-users-it-provisioned) | Next: [BEH-EA-253](30-scim.md#beh-ea-253-provisioning-lifecycle-changes-are-published-as-events)_

## BEH-EA-253: Provisioning lifecycle changes are published as events

```text
REQUIREMENT: The plugin MUST publish `auth.scim.userProvisioned`,
             `auth.scim.userDeactivated`, `auth.scim.userReactivated`,
             `auth.scim.userDeleted` and `auth.scim.groupChanged`
             (`created`/`updated`/`deleted`), each naming the SCIM connection
             and organization, so the durable `AuditLog` ([BEH-EA-100](13-events.md))
             records who was provisioned or offboarded and by which directory.
             A repeat `POST` that converges on an existing user MUST NOT
             publish `userProvisioned` again.
```

The audit actor is the connection, not a user: the connection id rides in the event payload, and no user id is recorded as the actor.

_Previous: [BEH-EA-252](30-scim.md#beh-ea-252-the-wire-format-follows-rfc-7644-content-types-filters-paging-errors-and-discovery)_
