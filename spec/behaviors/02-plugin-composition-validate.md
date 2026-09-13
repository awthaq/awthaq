# Plugin Composition and Validate&lt;P&gt;

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-02 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/design/plugins-as-layers.md` §4 and `archive/PRD.md` §9.4 — not code that has shipped.

## BEH-EA-009: `Auth.make` computes three outputs from one plugin tuple

> **See:** [ADR-EA-002](../decisions/002-plugin-graph-read-off-service-graph.md), [ADR-EA-008](../decisions/008-plugin-is-context-service-class.md)

```ts
export const make = <const P extends ReadonlyArray<AuthPlugin.Any | AuthPlugin.Variant>>(
  plugins: Auth.Validate<P>
): Auth.Built<P>

export interface Built<P extends ReadonlyArray<AuthPlugin.Any | AuthPlugin.Variant>> {
  readonly api: HttpApi.HttpApi<"auth", CoreGroups | GroupsOf<P[number]>>
  readonly layer: Layer.Layer<
    AuthCore | PluginOf<P[number]> | HttpApiGroup.ToService<"auth", CoreGroups | GroupsOf<P[number]>>,
    Layer.Error<LayerOf<P[number]>> | ConfigError,
    Exclude<Layer.Services<LayerOf<P[number]>>, AuthCore | PluginOf<P[number]> | SlotsOf<P[number]>>
  >
  readonly migrations: Migrations
  readonly manifest: Manifest
}
```

```text
REQUIREMENT: `auth.api`, `auth.layer`, and `auth.migrations` MUST all be
             computed from the same plugin tuple `P` passed to `Auth.make`,
             so that a contract cannot exist without its handlers, and
             handlers cannot exist for a group the contract lacks.
```

`archive/design/plugins-as-layers.md` §4.1 states the property this design intends to make structurally true rather than merely tested: because `api` and `layer` are two projections of one input, "contract added but handlers absent, or the reverse" moves from the list of things a test suite must check to the list of things that cannot be expressed. `research/13-modularity-foundations.md`'s reading of Perry & Wolf (1992) frames `HttpApi` and `Layer` as first-class connectors the compiler is meant to validate together, rather than incidental wiring a linker reconciles after the fact.

## BEH-EA-010: `Validate<P>`'s `DuplicateId` check refuses two plugins sharing an id

> **Invariant:** [INV-EA-003](../invariants.md#inv-ea-003-two-plugins-declaring-the-same-id-is-a-compile-time-error-at-authmake)

```ts
export type Validate<P extends ReadonlyArray<Any>> =
  DuplicateId<P> extends infer D extends string
    ? { readonly "awthaq": `plugin id "${D}" appears more than once` }
    : /* … */ P
```

```text
REQUIREMENT: Passing two plugins with the same `id` to `Auth.make` MUST fail
             to type-check, with the argument's type narrowed to a literal
             string naming the duplicated id, before `Layer.launch` is ever
             reached.
```

Without this check, two independently authored plugins that happen to choose the same id (two third-party packages both named `"invite"`, for instance) would fold onto one another's handler groups, tables, and migrations at the point the tuple is composed — the "last-wins merge" failure `archive/PRD.md` §2 names as a documented weakness of better-auth's untyped plugin model. `Validate<P>` is designed to walk the tuple pairwise (`archive/design/plugins-as-layers.md` §4.2), reading only `id`, so a fifty-plugin composition costs a few thousand cheap type instantiations, not a recursive walk into any plugin's internals.

## BEH-EA-011: `Validate<P>`'s `MissingDep` check names an absent dependency by plugin id

```ts
const auth = Auth.make([TwoFactor, Passkey])
// error TS2345: Argument of type '[typeof TwoFactor, typeof Passkey]' is not assignable to parameter of type
//   '{ readonly "awthaq": "plugin \"two-factor\" depends on plugin \"password\", which is not in the list"; }'.
```

```text
REQUIREMENT: If a plugin in the tuple depends (via `dependsOn`) on a plugin
             not present in the same tuple, `Auth.make` MUST fail to
             type-check with a literal string naming both the missing
             plugin and the plugin that requires it.
```

> **Invariant:** [INV-EA-001](../invariants.md#inv-ea-001-a-plugin-dependency-that-is-not-installed-keeps-the-application-from-compiling)

Because a plugin dependency is a service instance whose key literally contains `awthaq/plugin/<id>` (BEH-EA-002), `MissingDep<P>` can extract that id from the type and report it by name rather than leave the author with an opaque "some service is missing" diagnostic. `research/09-plugin-architecture.md` Q22 treats this as the central lesson of tRPC's `TS2589` failures: graph reasoning belongs to a shallow, purpose-built conditional type over a small tuple, never to open-ended recursive inference — which is exactly the shape `DuplicateId`/`MissingDep`/`SlotConflict` share.

## BEH-EA-012: `Validate<P>`'s `SlotConflict` check refuses two plugins overriding one exclusive slot

```ts
const auth = Auth.make([Roles, Organization])
// error TS2345: … '{ readonly "awthaq": "slot \"awthaq/slot/SubjectResolver\" is overridden by both \"roles\" and \"organization\""; }'
```

```text
REQUIREMENT: If two plugins in the tuple both provide the same slot
             (`Context.Reference`) in their Layer's `ROut`, `Auth.make`
             MUST fail to type-check, naming the slot and both contending
             plugin ids.
```

> **Invariant:** [INV-EA-004](../invariants.md#inv-ea-004-two-plugins-overriding-the-same-exclusive-slot-is-a-compile-time-error-at-authmake)

`SlotConflict<P>` walks the tuple's `ROut` types pairwise for a shared slot key (`archive/design/plugins-as-layers.md` §3.5, §4.2). The alternative — silent last-registration-wins, which is how Angular's non-`multi` DI providers and NestJS's global modules behave (`research/09-plugin-architecture.md` Q23) — is exactly the ambiguity a slot is designed to rule out: two plugins that both want to be *the* `SubjectResolver` must either compose explicitly or have one depend on and wrap the other; the compiler refuses to pick silently.

## BEH-EA-013: `api` and `layer` diverging from one another is unrepresentable, not merely untested

```text
REQUIREMENT: There MUST be no code path by which `auth.api` contains a
             group whose handler service is absent from `auth.layer`'s
             `ROut`, or by which `auth.layer` provides a handler for a
             group `auth.api` does not declare.
```

`archive/design/plugins-as-layers.md` §4.1 states this plainly: "`api` and `layer` are computed from the same `P`... That was a linker rule; now it is a fact about the return type." This is the sharpest contrast the design draws against better-auth's plugin model, where endpoints and schema are independently optional fields on a plugin record interpreted by hand-written composition code (`research/09-plugin-architecture.md` TL;DR) — a contract/handler mismatch there is a runtime discovery, not an unrepresentable state.

## BEH-EA-014: `Layer.launch` refuses to compile while any port remains unprovided

```ts
const auth = Auth.make([Password, Passkey])
Layer.launch(HttpRouter.serve(Routes).pipe(Layer.provide(auth.layer), Layer.provide(NodeHttpServer.layer(...))))
// error TS2345: Argument of type 'Layer<never, ConfigError | SqlError, Mailer | PasswordHasher | SqlClient>' is not assignable
//   to parameter of type 'Layer<never, unknown, never>'.
//     Type 'Mailer | PasswordHasher | SqlClient' is not assignable to type 'never'.
```

```text
REQUIREMENT: `Layer.launch` (or any `Effect.provide` expecting `never`
             remaining requirements) MUST refuse to type-check while
             `auth.layer`'s `RIn` still names an unprovided port, listing
             every such port by name in the diagnostic.
```

> **Invariant:** [INV-EA-002](../invariants.md#inv-ea-002-a-port-with-no-implementation-keeps-the-application-from-compiling)

This is a distinct failure site from `Auth.make` itself: `Auth.make`'s own diagnostics are the curated, readable strings `Validate<P>` produces (duplicate id, missing dependency, slot conflict); a missing port instead surfaces as Effect's ordinary "`X` is not assignable to `never`" `Layer` diagnostic, naming the unsatisfied services directly (`archive/design/plugins-as-layers.md` §9, "Error messages"). Removing a single `Layer.provide(Mailer.layerSes)` line from an application's wiring is designed to be exactly this: a compile error at the call to `Layer.launch`, not an incident discovered when a password-reset email silently fails to send in production.

## BEH-EA-015: A plugin definition itself, not `Auth.make`, is where a namespace violation is caught

```ts
export class Invite extends AuthPlugin.Service<Invite, InviteShape>()("acme.invite", {
  apiVersion: 1,
  contract: HttpApi.make("auth").add(HttpApiGroup.make("invitations").add(/* … */))
})
// error TS2322: Type 'HttpApiGroup<"invitations", …>' is not assignable to type 'HttpApiGroup<"acme.invite" | `acme.invite.${string}`, any, any>'.
```

```text
REQUIREMENT: A plugin whose `contract` names a group outside its own
             namespace MUST fail to type-check at the plugin's own class
             definition, and MUST NOT be expressible as a value that could
             ever reach `Auth.make` in the first place.
```

This entry exists to make an ordering property explicit: of the four compiler-error transcripts `archive/design/plugins-as-layers.md` §4.3 documents, three (duplicate id, missing dependency, slot conflict) are `Auth.make`-site failures over the composed tuple, while this fourth one is caught earlier, at the point a single plugin author writes their own class — the namespace constraint from BEH-EA-004 is a property of one plugin in isolation, so it needs no information about any other plugin to enforce, and enforcing it as early as possible means a malformed plugin can never be published as a working package in the first place.

## BEH-EA-016: The linker still performs two runtime checks the type system cannot express: cycle detection and migration ordering

```ts
export const core = [Users, Accounts, Sessions, Verification, Authentication, Csrf, SessionView] as const
export const make = (plugins) => build([...core, ...plugins])
```

```text
REQUIREMENT: `Auth.make` MUST run Kahn's algorithm over the composed
             `dependsOn` graph to detect cycles, reporting the full cycle
             path, and MUST derive migration order (core first, then
             plugins in topological order, keys re-written
             `NNNN_<plugin>_<name>`) — both as a runtime step, not a type-level
             one.
```

`archive/design/plugins-as-layers.md` §7 is explicit that these two facts are "not representable in types": a cycle in `dependsOn` would require a circular import of class values (nearly impossible to write by accident, but not impossible to type away), and migration order is a total order over the dependency graph that the type system has no need to compute since no code path depends on its result at compile time. `research/09-plugin-architecture.md` Q22 treats this as the correct division of labor — Kahn's algorithm belongs to the linker precisely so that the type system, per the tRPC `TS2589` lesson, never attempts open-ended graph reasoning of its own.

_Previous: [BEH-EA-008](01-plugin-contract.md#beh-ea-008-dependson-declares-both-ordering-and-a-typed-requirement-in-one-static-array)_
_Next: [BEH-EA-017](03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value)_
