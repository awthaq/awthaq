# Admin (Impersonation)
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-15 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-002) |
---

## What it is

A plan for an `Admin` plugin whose entire purpose is impersonation: letting
an administrator act as another user for a bounded window, without the
target's own credentials, while the resulting principal still carries who is
really behind the wheel. `archive/PRD.md` §17's Phase-2 row states it
plainly: "`Admin` (impersonation with hard expiry and `actingAs`)." Nothing
described here exists yet — effect-auth is pre-implementation, and this
document is non-normative: it records intent, not a verified behavior.

## Who asks for it

Support and operations teams that need to reproduce a user-reported problem
from inside the user's own account, rather than guessing at it from logs —
the same "support ticket" scenario `archive/design/usage-examples-v4.md` §19
uses as its worked example (`reason: "support ticket #4821"`). `archive/PRD.md`
§18 (Security model) lists impersonation as a named security-model concern
in its own right, not an afterthought bolted onto sessions: "Impersonation
off by default, admin-gated, reason required, hard expiry, dual identity,
audit events." That every one of those six properties is named explicitly in
a security-model section, rather than left implicit, is itself evidence this
plugin is asked for by teams who expect impersonation to be a deliberately
narrow, audited capability rather than a generic "log in as" backdoor.

## Status

| Property | Value |
|---|---|
| Status | Planned-Phase2 |
| Priority | P2 |
| Enabler(s) | E4 — Hook-point step-up/divert wiring (impersonation is a session-issuance variant gated on admin privilege, the same shape of wiring Two-Factor's divert hook and Device Authorization draw on); `00-adoption-matrix.md` §6 records as an open question whether this plugin instead needs a dedicated enabler category of its own rather than reusing E4. |
| Breaking? | Additive: no existing plugin, port, or slot is redefined. `Admin` contributes a new session-issuance path and a new `actingAs` field on the principal shape (`archive/PRD.md` §10 already keeps `principal` open to more than one case, as `07-api-keys.md`'s `ApiKeyPrincipal` notes for the same reason); it does not reopen the Planned-MVP session contract. |

## How it would be expressed

Following `archive/PRD.md` §9.1's `AuthPlugin.Service` shape, and the
`admin({ impersonation: { maxDuration } })` factory named in
`archive/design/usage-examples-v4.md` §19:

```ts
export class Admin extends AuthPlugin.Service<Admin, AdminShape>()("admin", {
  apiVersion: 1,
  contract: AdminApi,             // POST /auth/admin/impersonate, POST /auth/admin/stop-impersonating
  tables: ["admin_impersonation"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Admin, {
    dependsOn: [Sessions, Users],
    make: Effect.gen(function*() {
      const config = yield* AdminConfig     // impersonation.maxDuration, admin-gate check
      /* impersonate(userId, reason) -> new session row: userId = target,
         actingAs = { type: "user", id: admin }; hard expiry from maxDuration,
         no sliding refresh; publishes auth.session.issued with actingAs
         stopImpersonating() -> ends the impersonation session */
      return Admin.of({ impersonate, stopImpersonating })
    }),
    handlers: AdminHandlers
  })
  static readonly config = (c: Partial<AdminConfigShape>) => Layer.succeed(AdminConfig, { ...defaults, ...c })
}
```

Once installed, the `actingAs` it produces is what `SubjectResolver` is
already asserted to support: `18-roles-subject-resolver.md`'s statement that
`attributes.actingAs` is a static subject attribute is written as a property
`SubjectResolver` must honor if an `Admin` plugin is installed — this model
is the plugin that would actually install it. See that file's note on
`MOD-EA-015` for the honest framing of that dependency.

## Worked example

`archive/design/usage-examples-v4.md` §19 and `archive/design/usage-qadi.md`
§11 both carry worked material for this plugin, so this is not a fabricated
example:

```ts
// usage-examples-v4.md §19
const plugins = [password(), roles({ graph }), admin({ impersonation: { maxDuration: Duration.hours(1) } })] as const

yield* client.admin.impersonate({ params: { userId }, payload: { reason: "support ticket #4821" } })
// new session row: userId = target, actingAs = admin; hard 60-minute expiry, no sliding refresh
// CurrentPrincipal → UserPrincipal { userId: target, actingAs: { type: "user", id: admin } }
// events: auth.session.issued with actingAs; UI reads session.subject.attributes.actingAs to show a staff bar
yield* client.admin.stopImpersonating()
```

```ts
// usage-qadi.md §11 — how a policy branches on an active impersonation
export const readOnlyWhileImpersonating = rules([
  denyWhen(allOf([hasAttribute("actingAs", exists()), hasAction("write")])),
  permitWhen(hasPermission(project.update))
], { combining: "DenyOverrides" })

yield* enforce(readOnlyWhileImpersonating, { action: "write", resource })(update)
```

Both fences are adapted from their respective source files (already `ts`
fences in the source). Neither shows the admin-gate check itself (how
`impersonate` verifies the caller holds admin privilege before issuing the
session) or the audit-event schema beyond the one `auth.session.issued`
annotation shown above.

## What is missing

No behaviors file specifying impersonation session issuance, hard-expiry
enforcement, or audit-event emission has been written yet — no `BEH-EA` ids
are allocated to this plugin anywhere in `spec/behaviors/`. Concretely
undecided: the exact admin-gate check (a role check via `Roles`, a
dedicated `AdminPrincipal`, or something else — `usage-qadi.md` §11's
`readOnlyWhileImpersonating` example implies policies see `actingAs` but does
not specify how `impersonate` itself is gated), the `admin_impersonation`
table shape, the reason field's validation (length, required-ness beyond
"required" per `archive/PRD.md` §18), the exact audit-event schema beyond the
one `auth.session.issued` annotation `usage-examples-v4.md` §19 shows, and
whether `stopImpersonating` is caller-initiated only or also forced by an
administrator ending someone else's impersonation session.

`spec/invariants.md`'s **INV-EA-014** ("An impersonation session carries a
hard expiry with no sliding refresh") is the invariant this model is
expected to eventually back once real behaviors exist for this plugin; today
that invariant's enforcement is planned against a test file
(`packages/core/test/Impersonation.test.ts`) that does not exist, backed by
no behavior file at all, which is exactly the gap this model exists to make
visible rather than paper over.

## Verification

None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md), [invariants.md](../invariants.md#inv-ea-014-an-impersonation-session-carries-a-hard-expiry-with-no-sliding-refresh) (INV-EA-014)_
