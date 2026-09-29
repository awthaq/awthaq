# Roles and the Subject Resolver
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-18 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Corrected BEH-EA-142's false citation of "file 06's admin plugin" — file 06 is Users and Accounts, not an Admin plugin; no Admin plugin behaviors exist yet (CCR-EA-002) <br> 1.2 (2026-09-29): Status banner corrected to implemented-with-deviations (RRM-009); BEH-EA-138's enforcement point restated as layer-build, not `Auth.make` (RRM-012); BEH-EA-139 gained catalog validation, `UnknownRole`, drift observability and role-change audit events (RRM-003/004/005/010) |
---

> **Status: implemented with deviations.** `@awthaq/roles` ships BEH-EA-137–139, 142 and 143 (`Roles.layer` / `Roles.layerSql`, the `SubjectResolver` slot override, catalog validation, role-change audit events). Deviations: BEH-EA-138's exclusivity is enforced when layers are built via the opt-in `Slots.SlotsRegistry`, not by `Auth.make`'s type checker (see that behavior); BEH-EA-140/141 (API-key/service scopes become permissions) are not implemented — `ApiKeyPrincipal`/`ServicePrincipal` carry no `scopes` field yet; BEH-EA-144's session-view exposure follows `@awthaq/qadi`'s standalone `GET /subject`.

## BEH-EA-137: The SubjectResolver slot defaults to identity-only

```ts
interface SubjectResolver { readonly resolve: (principal: Principal) => Effect<AuthSubject> }
// default: AuthSubject.id only, no roles, no permissions
```

```text
REQUIREMENT: The default `SubjectResolver` MUST produce an `AuthSubject`
             carrying only `id`; it MUST NOT invent roles or permissions in
             the absence of a plugin that provides them.
```

`usage-qadi.md` §1's table is explicit about the consequence: "`User` without roles plugin → `id` only. Every policy that needs a role or permission denies." This is qadi's own fail-closed posture (PRD §5's "failure is not denial; absence is refusal" applied to the identity a policy evaluates) carried into awthaq's one piece of authorization surface: installing no roles plugin means every permission-gated policy denies by construction, never by an implicit "everyone can" default.

_Previous: [BEH-EA-136](17-passkey.md#beh-ea-136-typed-errors-are-enumeration-safe) | Next: [BEH-EA-138](18-roles-subject-resolver.md#beh-ea-138-roles-overrides-the-slot-exclusively)_

## BEH-EA-138: `Roles` overrides the slot exclusively

> **See:** [ADR-EA-012](../decisions/012-slots-exclusive-registries-aggregate.md)

```ts
export const auth = Auth.make([Password, Organization, Roles])
// installing a second plugin that overrides SubjectResolver fails when the layers are built
```

```text
REQUIREMENT: At most one installed plugin MAY override the `SubjectResolver`
             slot; installing two plugins that both override it MUST fail
             during composition — when the layers are built (through
             `Slots.SlotsRegistry`, provided by `Slots.layer`) — before any
             request is served, naming both owners and the slot.
```

`SubjectResolver` is a `Context.Reference` slot per ADR-EA-012 — exclusive by construction, unlike a registry which aggregates. `usage-qadi.md` §1 places the enforcement at `Auth.make`, but a `Context.Reference` slot override is invisible to `Auth.make`'s type-level checks (a structural limit of `Context.Reference` in this `effect` version — see `packages/core/src/Slots.ts`'s header), so the shipped enforcement point is layer construction: `Slots.override` registers each claim with `Slots.SlotsRegistry` and the second claim fails with `SlotConflict`, which still happens at startup rather than on a request (`packages/roles/test/AuthComposition.test.ts` pins it). Two plugins each redefining what a subject's roles mean would produce silently inconsistent authorization depending on plugin order — the slot design removes that failure mode entirely rather than documenting a resolution order.

_Previous: [BEH-EA-137](18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only) | Next: [BEH-EA-139](18-roles-subject-resolver.md#beh-ea-139-roles-flatten-through-the-dag-once-per-resolution)_

## BEH-EA-139: Roles flatten through the DAG once per resolution

```ts
export const owner  = role({ name: "owner",  permissions: [project.delete, billing.manage], inherits: [editor] })
// GET /auth/session → subject.roles: ["admin", "member"], subject.permissions: ["project:read", …]
```

```text
REQUIREMENT: `SubjectResolver` MUST flatten a user's assigned roles through
             qadi's role inheritance graph into a pre-computed `permissions`
             set at resolution time; a policy evaluation MUST NOT walk the
             role graph itself. The role catalog MUST NOT define two roles
             with the same name (the layer refuses to build, naming the
             duplicates); assigning a name absent from the catalog MUST fail
             with a typed `UnknownRole`; a stored assignment that has drifted
             out of the catalog MUST be observable (a warning when a subject is
             resolved, and `listUnknownAssignments`); and every real change to
             a user's global role assignments MUST publish `auth.roles.assigned`
             / `auth.roles.revoked` (durably audited, recording the actor when
             the caller supplies one) — a no-op re-assign or revoke publishes
             nothing.
```

This is qadi's own house rule from `spec/behaviors/01-permissions.md`'s design ("a subject carries a pre-flattened `ReadonlySet` of permission keys, so a permission check is a set membership test rather than a graph walk") applied at the point awthaq hands qadi a subject: the DAG walk happens once, in `SubjectResolver`, so every downstream `check`/`enforce`/`filter` call is O(1) set membership rather than re-deriving inheritance on every request.

_Previous: [BEH-EA-138](18-roles-subject-resolver.md#beh-ea-138-roles-overrides-the-slot-exclusively) | Next: [BEH-EA-140](18-roles-subject-resolver.md#beh-ea-140-api-key-scopes-become-permissions)_

## BEH-EA-140: API-key scopes become permissions

```ts
// CurrentPrincipal → ApiKeyPrincipal { keyId, scopes: ["project:read"] }
// AuthSubject: id: "apikey:<keyId>", permissions = the key's scopes
```

```text
REQUIREMENT: For an `ApiKeyPrincipal`, `SubjectResolver` MUST map the key's
             configured scopes directly onto `AuthSubject.permissions`; it
             MUST NOT grant a scope the key was not issued with, and MUST NOT
             consult the role graph for a key.
```

`usage-qadi.md` §1's table states this mapping as one of the four principal-to-subject rows. Scopes and roles are deliberately different mechanisms feeding the same `permissions` set: a service credential is provisioned with an explicit, minimal scope list at creation (`usage-examples-v4.md` §20), never inherited through a role hierarchy meant for interactive users.

_Previous: [BEH-EA-139](18-roles-subject-resolver.md#beh-ea-139-roles-flatten-through-the-dag-once-per-resolution) | Next: [BEH-EA-141](18-roles-subject-resolver.md#beh-ea-141-service-principals-carry-their-own-scopes)_

## BEH-EA-141: Service principals carry their own scopes

```ts
// AuthSubject: id: "service:<name>", permissions = its scopes
```

```text
REQUIREMENT: For a `ServicePrincipal`, `SubjectResolver` MUST resolve
             `permissions` from the service's own declared scopes, independent
             of any user or API-key subject.
```

`usage-qadi.md` §1's table gives `Service` its own row distinct from `ApiKey`, and `usage-examples-v4.md` §10.7 shows a service principal (`reportsService`) being resolved and used to run `filter` against a policy — a background job authenticates as itself, not as a stand-in for a user, and its permission set reflects exactly the scopes it was configured with, nothing borrowed from a human session.

_Previous: [BEH-EA-140](18-roles-subject-resolver.md#beh-ea-140-api-key-scopes-become-permissions) | Next: [BEH-EA-142](18-roles-subject-resolver.md#beh-ea-142-impersonation-is-a-static-subject-attribute)_

## BEH-EA-142: Impersonation is a static subject attribute

```ts
// CurrentPrincipal → UserPrincipal { userId: target, actingAs: { type: "user", id: admin } }
// subject.attributes.actingAs
```

```text
REQUIREMENT: When a principal carries `actingAs`, `SubjectResolver` MUST place
             it on `AuthSubject.attributes.actingAs`; policies that need to
             branch on impersonation MUST read it from the subject's static
             attributes, never through an `AttributeResolver` round-trip.
```

`usage-qadi.md` §16 states the general rule this instance follows: "static on the subject, revocable through a resolver — `actingAs` and roles ride on the subject; plan and verification status come from `AttributeResolver`." Impersonation state is intended to be fixed for the lifetime of the impersonation session, set once at issuance, so putting it on the subject directly would be both correct and cheaper than a resolver call on every policy evaluation; a value that can change independently of the session — like a subscription plan — is the case a resolver exists for instead. This requirement asserts a property `SubjectResolver` must support **if** an `Admin` plugin supplying `actingAs` is installed — the `Admin` plugin itself is not yet specified anywhere in this repository. `06-domain-users-accounts.md` is Users and Accounts, not an admin plugin, and no file under `spec/behaviors/` defines one. The only record of intent for such a plugin is the non-normative [MOD-EA-015](../models/15-admin-impersonation.md) adoption record; no `BEH-EA` ids are yet allocated to it.

_Previous: [BEH-EA-141](18-roles-subject-resolver.md#beh-ea-141-service-principals-carry-their-own-scopes) | Next: [BEH-EA-143](18-roles-subject-resolver.md#beh-ea-143-no-credential-resolves-to-qadis-anonymous-subject)_

## BEH-EA-143: No credential resolves to qadi's `anonymous` subject

```ts
// no credential → qadi's anonymous
```

```text
REQUIREMENT: When `CurrentPrincipal` is `AnonymousPrincipal`, `SubjectResolver`
             MUST produce qadi's canonical `anonymous` subject; it MUST NOT
             synthesize a distinct awthaq-specific representation of "no
             one."
```

`usage-qadi.md` §1's table lists this as the fourth resolution row. Using qadi's own `anonymous` value rather than an awthaq equivalent means every policy already written against qadi's anonymous semantics (public-read rules, `anyOf` branches that check `hasResourceAttribute("visibility", eq("public"))` without needing a role) behaves identically whether the caller came through awthaq or through any other qadi-fronted service — one subject shape, one evaluator, per `usage-qadi.md` §16's "one evaluation path" rule.

_Previous: [BEH-EA-142](18-roles-subject-resolver.md#beh-ea-142-impersonation-is-a-static-subject-attribute) | Next: [BEH-EA-144](18-roles-subject-resolver.md#beh-ea-144-the-session-view-exposes-the-resolved-subject)_

## BEH-EA-144: The session view exposes the resolved subject

```ts
// GET /auth/session
// 200 {"principal":{...},"user":{...},"session":{...},"subject":{"id":"user:…","roles":[],"permissions":[],"attributes":{}}}
```

```text
REQUIREMENT: `SessionView` MUST include the `subject` produced by
             `SubjectResolver` for the current principal, encoded as
             `SubjectDto` with plain arrays; it MUST NOT omit `subject` merely
             because no roles plugin is installed.
```

The client and React bindings (files 22–23) derive `qadi`'s in-browser `AuthSubject` from exactly this field (`makeSubject({ id: v.subject.id, roles: v.subject.roles, ... })` in `usage-qadi.md` §12.1), so `subject` must be present on every `SessionView` — with empty `roles`/`permissions` arrays when no roles plugin is installed, per BEH-EA-137 — for the client's subject derivation to have a stable field to read regardless of which plugins the application installed.

_Previous: [BEH-EA-143](18-roles-subject-resolver.md#beh-ea-143-no-credential-resolves-to-qadis-anonymous-subject) | Next: [BEH-EA-145](19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject)_
