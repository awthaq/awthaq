# SCIM
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-12 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
A plan for a `Scim` plugin implementing the System for Cross-domain Identity Management protocol so that a customer's identity provider can automatically create, update, and deactivate user accounts in an effect-auth-backed application ("directory sync"), instead of an administrator managing users by hand. Like `OidcProvider`, this asks effect-auth to be the receiving end of another system's authority rather than a relying party consuming an external one — it is the identity-provider-as-server enabler applied to user lifecycle rather than to token issuance.

## Who asks for it
Enterprise IT/identity teams who provision and deprovision employee accounts centrally and expect every downstream application to stay in sync automatically — offboarding being the operative case (an application that does not support SCIM leaves a terminated employee's account active until someone remembers to remove it by hand). `research/03-auth-landscape.md`'s strategy-phase inventory lists "SCIM / directory sync" with adopters "WorkOS, better-auth SCIM plugin, Keycloak, Casdoor, Logto, FusionAuth," categorized "Phase 3 / paid tier," and its own recommendation ordering places it explicitly "after SSO." The TL;DR section's monetization note ("WorkOS $125/connection SSO/SCIM") and the Wave 3 framing ("B2B money... where every vendor paywalls") both apply here as much as to SAML. `archive/PRD.md` §17 lists `Scim` as a Phase 3 official plugin, with no further elaboration.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase3 |
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
  tables: [],
  migrations: []
}) {
  static readonly layer = AuthPlugin.layer(Scim, {
    dependsOn: [Users],
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

## What is missing
This is the least-designed row in the whole matrix. Beyond the one-line mention in `archive/PRD.md` §17 and the landscape evidence in `research/03-auth-landscape.md`, there is no `ScimApi` contract, no decision on how SCIM's resource/schema model maps onto the `Users`/`Organization` tables, no authentication design for the bearer token a directory service would present, and no answer to how a SCIM-deactivated user interacts with already-issued sessions. `research/03-auth-landscape.md` documents that SCIM is universally a paid, Phase-3, "after SSO" capability across the competitive field, which supports the Phase 3 placement and P4 priority here, but it does not propose an effect-auth-specific design.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
