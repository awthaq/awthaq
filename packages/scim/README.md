# @awthaq/scim

Inbound **SCIM 2.0** (RFC 7643/7644) provisioning: an organization's identity provider (Okta, Entra ID, OneLogin) creates, updates and deactivates its users and groups over `/scim/v2`, and **deactivation ends their sessions at once**. Specified in [`spec/behaviors/30-scim.md`](../../spec/behaviors/30-scim.md) (BEH-EA-241 through 248) and [`spec/models/12-scim.md`](../../spec/models/12-scim.md); the scope decision is [ADR-EA-023](../../spec/decisions/023-enterprise-federation-packages.md).

```ts
const auth = Auth.make([Organization.Organization, Scim.Scim]); // Scim dependsOn [Organization]

// Provide (once, application-wide): the records, the bearer scheme, the connection store.
Scim.Scim.layer.pipe(
  Layer.provide(ScimConnections.ScimAuthenticationLive), // the `scim` group's bearer middleware
  Layer.provide(Scim.config({ baseUrl: Option.some("https://id.example.com") })),
  Layer.provideMerge(ScimConnections.layerStore),
  Layer.provideMerge(ScimRecords.layerSql), // or layerMemory
  /* + Organization.layer and its records */
);
```

## A connection

A SCIM **connection** is one organization's directory-sync credential. `ScimConnectionStore.create({ organizationId, name })` returns the bearer token **once** (`scim_` + 256 random bits); only its SHA-256 is stored, and `revoke` retires it without deleting what it provisioned. Paste the token and `https://<host>/scim/v2` into the IdP's "SCIM provisioning" settings (authentication mode: HTTP header / bearer token). A token for connection A can never read or change connection B's users. A missing, wrong or revoked token — and the token of an organization that is suspended (EP-003) — all answer the same `401`.

## What it does

| Endpoint | Behavior |
| --- | --- |
| `POST /Users` | Creates the user (an `Email` identity from the primary `emails` value or an address-shaped `userName`, else `Anonymous`), maps it to the connection, adds it to the organization. A repeat `POST` with the same `externalId` returns the existing user (reactivated if the directory now wants it active). |
| `GET /Users?filter=userName eq "…"` / `externalId eq "…"` | The two filters an IdP uses to find its own resource; `startIndex`/`count` paging. Anything else is `400 invalidFilter`. |
| `PUT` / `PATCH /Users/:id` | `displayName`/`name`, `externalId`, `active`. `PATCH` takes `add`/`replace`/`remove` (any case), with a `path` or Okta's path-less object, and `"True"`/`"False"` strings (Entra); attributes it does not manage are ignored. |
| `DELETE /Users/:id` | Deactivates by default; `Scim.config({ deleteBehavior: "erase" })` erases the user (`Users.delete`, running the erasure taps). |
| `/Groups` | A group is an organization **team**; members are the users the connection provisioned. |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery, behind the same token. |

## The safety rules

- **A connection acts only on what it provisioned.** `scim_resource` is the ownership map; a user or group with no row for the calling connection is a plain `404`, however it came to exist. `POST` **never adopts** an existing account: an email that already exists is `409 uniqueness` (a directory must not be able to claim, then suspend, someone else's global identity).
- **`userName` is immutable** after creation (`400 mutability`): an IdP-driven email change would be an account-takeover path.
- **`active: false` is suspension**, not deletion: `Users.setStatus("suspended")` then `Sessions.revokeAll`, so issued sessions die immediately and `Users.assertCanSignIn` refuses new ones. `active: true` lifts **only a suspension this connection made** — an administrator's ban stays.
- **Group changes only touch provisioned users**: a member list replaces the provisioned members of the team, never anyone else on it.

## Not built

`/Bulk`, `sortBy`, `/Me`, ETag concurrency, compound filters beyond the two `eq` forms, and nested-group push (a team's own hierarchy is not exposed). Group changes go straight to the team records, so the organization plugin's team *hooks* do not run for them; they publish `auth.scim.groupChanged`. There is no HTTP CRUD for connections yet — create and revoke them with `ScimConnectionStore` (or your own admin surface); directory-side rate limiting is the host's (put your usual limiter in front of `/scim`).

## Interim recipe (no directory wired yet)

Subscribe to `auth.organization.memberRemoved` (`AuthEvents.on`) and, when the user has no memberships left, call `Users.setStatus(userId, "suspended")` then `Sessions.revokeAll(userId, "suspended")` — exactly what `active: false` does.
