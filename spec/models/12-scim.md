# SCIM
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-12 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001); 1.1 (2026-09-29): record the identity and lifecycle decisions of wayfinder tickets 08/09 (SCP-005) <br> 1.2 (2026-09-29): implemented as `@awthaq/scim`; the contract, the ownership rules and the interim deprovisioning recipe (CWM-002, AOMS-009; [ADR-EA-023](../decisions/023-enterprise-federation-packages.md)) |
---

## What it is
A plan for a `Scim` plugin implementing the System for Cross-domain Identity Management protocol so that a customer's identity provider can automatically create, update, and deactivate user accounts in an awthaq-backed application ("directory sync"), instead of an administrator managing users by hand. Like `OidcProvider`, this asks awthaq to be the receiving end of another system's authority rather than a relying party consuming an external one — it is the identity-provider-as-server enabler applied to user lifecycle rather than to token issuance.

## Who asks for it
Enterprise IT/identity teams who provision and deprovision employee accounts centrally and expect every downstream application to stay in sync automatically — offboarding being the operative case (an application that does not support SCIM leaves a terminated employee's account active until someone remembers to remove it by hand). `research/03-auth-landscape.md`'s strategy-phase inventory lists "SCIM / directory sync" with adopters "WorkOS, better-auth SCIM plugin, Keycloak, Casdoor, Logto, FusionAuth," categorized "Phase 3 / paid tier," and its own recommendation ordering places it explicitly "after SSO." The TL;DR section's monetization note ("WorkOS $125/connection SSO/SCIM") and the Wave 3 framing ("B2B money... where every vendor paywalls") both apply here as much as to SAML. `archive/PRD.md` §17 lists `Scim` as a Phase 3 official plugin, with no further elaboration.

## Status
| Property | Value |
|---|---|
| Status | Implemented — `@awthaq/scim` ([ADR-EA-023](../decisions/023-enterprise-federation-packages.md), [BEH-EA-246 through 253](../behaviors/30-scim.md)) |
| Priority | P4 |
| Enabler(s) | E5 — Identity-provider-as-server |
| Breaking? | Additive: SCIM would add its own endpoints and its own user-provisioning entry point on top of the existing `Users` service without changing any Planned-MVP or Planned-Phase2 contract; the caveat is that E5 (identity-provider-as-server) is a separable subsystem whose shape is undecided, so "additive" describes the API surface, not the design effort. |

## How it would be expressed
```ts
export class Scim extends AuthPlugin.Service<Scim, {
  listUsers(query: ScimListQuery): Effect.Effect<ScimListResponse, ScimError>
  createUser(resource: ScimUserResource): Effect.Effect<ScimUserResource, ScimError>
  patchUser(id: string, ops: ScimPatchOp[]): Effect.Effect<ScimUserResource, ScimError>
  deactivateUser(id: string): Effect.Effect<void, ScimError>
}>()("scim", {
  apiVersion: 1,
  contract: ScimApi,          // /scim/v2/Users, bearer-token authenticated per RFC 7644
  tables: ["scim_connection", "scim_resource"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Scim, {
    dependsOn: [Organization],
    make: Effect.gen(function*() {
      /* map SCIM's resource schema onto the Users repository; not yet designed */
      return Scim.of({ listUsers, createUser, patchUser, deactivateUser })
    }),
    handlers: ScimHandlers
  })
}
```

## Worked example
No worked example drafted yet. Neither `archive/design/usage-examples-v4.md` nor `archive/design/usage-qadi.md` carries a SCIM section as of this revision.

## Decisions already made (wayfinder tickets 08 and 09)
The mapping and lifecycle questions below the "What is missing" heading were largely settled by the identity model, and are recorded here so a future `Scim` implementation does not re-open them:

- **Resource id.** The SCIM resource `id` is the awthaq `UserId` (an identifier, never a capability — INV-EA-018).
- **`externalId`.** The directory's `externalId` is persisted in a table owned by the `scim` package — `scim_resource(scimConnectionId, kind, resourceId, name, externalId)`, which is also the record of *which users and groups a connection provisioned* (the plan named it `scim_external_id`; `externalId` is optional in SCIM, so the row is per provisioned resource, not per external id) — deliberately not as an `Accounts` link and not as a column on `Users`, so no SCIM-specific concept leaks into `@awthaq/core` (ticket 08).
- **`active: false` is suspension, not deletion.** It maps to `Users.setStatus(userId, "suspended")` composed with `Sessions.revokeAll(userId, "suspended")`; `active: true` maps to `setStatus(userId, "active")`. The `UserSuspended` sign-in gate (`Users.assertCanSignIn`, BEH-EA-46) then refuses every sign-in path while every Account, the identity and the session history remain (ticket 09, SCP-001). This also answers "how a SCIM-deactivated user interacts with already-issued sessions": they are revoked at deactivation, and no new one can be issued.
- **`DELETE /Users/:id` is a different act.** It unlinks the `scim_external_id` mapping and then, by configuration, either erases the user (`Users.delete`, BEH-EA-46's cascade, running the `BeforeUserDelete` erasure taps) or suspends it; the observable postconditions differ from a deactivation (a deleted user's row, accounts and history are gone).
- **Email-less directory users.** A directory record without an email creates an `Anonymous` or `Phone` identity user (BEH-EA-41), never a synthetic address; `createOrGet` (SCP-003) makes a retried `POST /Users` idempotent.

See the design records: `.scratch/resolve-ready-for-human-findings/issues/08-saml-scim-roadmap-scope.md` and `.../09-userrecord-model-extension.md`.

## The contract (`ScimApi`)
`/scim/v2` per RFC 7644, bearer-token authenticated, content type `application/scim+json` (a request as `application/json` is accepted too — Okta sends that):

- `GET /Users?filter=userName eq "…"|externalId eq "…"&startIndex&count`, `POST /Users`, `GET`/`PUT`/`PATCH`/`DELETE /Users/:id`; `GET /Groups`, `POST /Groups`, `GET`/`PUT`/`PATCH`/`DELETE /Groups/:id` (a SCIM Group is an organization team of the connection's organization; members are that organization's users this connection provisioned).
- Discovery: `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`.
- Errors are RFC 7644 §3.12 (`schemas`, `status`, `scimType`, `detail`).

**Authentication.** A `scim_connection` belongs to one organization and holds only the SHA-256 of its bearer token (`scim_` + 256 random bits, shown once at creation, revocable). A token for connection A can never read connection B's users; every resource lookup is keyed by the connection.

**Ownership rules** (the safety design, [ADR-EA-023](../decisions/023-enterprise-federation-packages.md) Decision 5): a connection acts only on users **it provisioned**. `POST /Users` never adopts an existing account (an existing email is `409 uniqueness`); `userName` is immutable after creation; `active: true` reactivates only a suspension this connection made (a ban by an administrator stays); `DELETE` deactivates by default, or erases when configured.

## Interim deprovisioning recipe (until a directory is wired to `/scim/v2`)
An application that has an offboarding signal of its own can already end a departing member's access without SCIM: subscribe to `auth.organization.memberRemoved` (`AuthEvents.on`) and, when the user holds no remaining membership, call `Users.setStatus(userId, "suspended")` then `Sessions.revokeAll(userId, "suspended")` — exactly what `active: false` does.

## What is missing
Nothing of the Users and Groups core. Not built: SCIM bulk (`/Bulk`), `sortBy`, `/Me`, ETag concurrency, compound `filter` expressions beyond the two `eq` forms an IdP uses to find its own resource, and a `Groups` push of nested groups (a team's own hierarchy is not exposed).

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
