# Plugin Contract

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-01 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> effect-auth is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/design/plugins-as-layers.md` and `archive/PRD.md` §9 — not code that has shipped.

## BEH-EA-001: A plugin is a `Context.Service` class produced by `AuthPlugin.Service`

> **See:** [ADR-EA-008](../decisions/008-plugin-is-context-service-class.md), [ADR-EA-001](../decisions/001-plugins-contribute-layers.md)

```ts
export const Service = <Self, Shape>() =>
  <const Id extends string, Groups extends GroupsFor<Id>>(
    id: Id,
    options: {
      readonly apiVersion: 1
      readonly contract: HttpApi.HttpApi<"auth", Groups>
      readonly tables?: ReadonlyArray<`${Id}_${string}`>
      readonly migrations?: Migrations
    }
  ): Class<Self, Id, Shape, Groups>
```

```text
REQUIREMENT: `AuthPlugin.Service<Self, Shape>()(id, options)` MUST return a
             normal `Context.ServiceClass` — a plugin MUST be usable
             everywhere any other Effect service is usable (`yield* Plugin`,
             `Layer.provide`), with no second, plugin-specific runtime for
             resolution or lifecycle.
```

Every other capability in this file follows from this one design choice: a plugin is not an object interpreted by a bespoke compiler, it is a value the Effect runtime already knows how to compose. `archive/design/plugins-as-layers.md` §2.2 fixes the return type as `Context.ServiceClass<Self, "effect-auth/plugin/${Id}", Shape>` plus a handful of typed statics (`id`, `apiVersion`, `contract`, `tables`, `migrations`, `dependsOn`). Application code is intended to depend on a plugin exactly as it depends on any other service — `const password = yield* Password` — so "is this plugin installed" and "is this arbitrary service in scope" are designed to be the same question to the type checker.

## BEH-EA-002: A plugin's `id` is a literal, namespaced string that keys its service instance

```ts
type Class<Self, Id extends string, Shape, Groups extends HttpApiGroup.Constraint> =
  Context.ServiceClass<Self, `effect-auth/plugin/${Id}`, Shape> & { readonly id: Id }
```

```text
REQUIREMENT: A plugin's compiled service key MUST embed its own `id` as
             `effect-auth/plugin/<id>`, so that any other plugin's
             requirement on it is a service whose instance type carries
             `key: "effect-auth/plugin/<id>"` and can be named, not merely
             detected as an unsatisfied requirement.
```

This is the mechanism `Auth.make`'s `MissingDep<P>` depends on (see [02-plugin-composition-validate.md](02-plugin-composition-validate.md)): because a plugin dependency is a service whose key literally contains its owner's id, a missing-dependency diagnostic can name the plugin by id rather than report an opaque unsatisfied `RIn`. `research/09-plugin-architecture.md` Q23 recommends exactly this discipline — third-party ids derived from an npm scope, core ids reserved — precisely so that no two installed plugins can collide on identity by accident.

## BEH-EA-003: `apiVersion: 1` is a literal generation gate, checked pairwise at `Auth.make`

```ts
readonly apiVersion: 1
```

```text
REQUIREMENT: A plugin built against a Plugin API generation other than the
             one `Auth.make` accepts MUST fail to type-check as an argument
             to `Auth.make`, naming the offending plugin, before any other
             validation runs.
```

`research/09-plugin-architecture.md` Q20 names the failure mode this rule exists to prevent: Gatsby's plugin ecosystem had no enforced API-version gate across majors, and plugins pinned to a specific host version silently rotted as majors shipped. effect-auth's plan is the opposite of a silent shim — `apiVersion: 1` is a TypeScript literal, not a semver range checked at runtime, so a plugin authored against a future Plugin API 2 cannot be passed to a v1 `Auth.make` and quietly "mostly work."

## BEH-EA-004: A plugin's contract groups are constrained to its own namespace by a template-literal type

```ts
type GroupsFor<Id extends string> = HttpApiGroup.HttpApiGroup<Id | `${Id}.${string}`, any, any>
```

```text
REQUIREMENT: A plugin's `contract` MUST fail to type-check, at the plugin's
             own definition site, if it declares any `HttpApiGroup` whose id
             is neither its own `id` nor a dotted sub-id of it.
```

> **Invariant:** [INV-EA-006](../invariants.md#inv-ea-006-a-plugins-contract-group-named-outside-its-own-namespace-fails-the-plugins-own-type-definition)

`archive/design/plugins-as-layers.md` §4.3 shows the shape of the failure this produces: an `Invite` plugin whose contract adds an `HttpApiGroup.make("invitations")` (unprefixed) fails `TS2322` at the class definition, because `"invitations"` does not satisfy `"acme.invite" | \`acme.invite.${string}\`}`. This closes, at authoring time rather than at `Auth.make` or route-registration time, the route-collision failure mode `research/09-plugin-architecture.md` Q24 documents for better-auth, whose equivalent rule ("add the plugin name as a prefix") is a documented convention, not a checked one.

## BEH-EA-005: A plugin's table names are constrained to its own prefix by a template-literal type

```ts
readonly tables?: ReadonlyArray<`${Id}_${string}`>
```

```text
REQUIREMENT: Every entry in a plugin's `tables` array MUST be a string
             literal beginning with `<id>_`; a bare table name MUST fail to
             type-check as an argument to `AuthPlugin.Service`.
```

`research/09-plugin-architecture.md` Q25 contrasts better-auth's convention-only table naming (plugins may create arbitrary table names, with only a documentation warning against colliding with core) against Medusa 2.0's strict per-module isolation. effect-auth's plan follows Medusa's discipline but enforces it the same way it enforces group namespacing (BEH-EA-004): as a template-literal constraint on the plugin's own static declaration, so a bare or core-colliding table name is rejected before the plugin can be published, not merely flagged by a linter a plugin author could ignore.

## BEH-EA-006: `migrations` is a static, declarative member — never computed from runtime configuration

```ts
export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", {
  apiVersion: 1,
  contract: PasswordApi,
  tables: ["password_account"],
  migrations
}) { /* … */ }
```

```text
REQUIREMENT: A plugin's `migrations` value MUST be resolvable by reading the
             plugin's static class members alone, with no `Layer` evaluated
             and no configuration service provided — the same value for
             every runtime configuration of that plugin.
```

`archive/PRD.md` §5 (Design principle 3, "Declarative, frozen, static") and `research/09-plugin-architecture.md` Q30 both fix this as a hard line: installation is code, configuration is data, and a schema-affecting fact (which tables exist, which migrations run) is an installation fact, never a runtime one. This is also what makes the CLI's manifest (`effect-auth plugin list --graph`, `schema`) possible without executing a single `Layer`: the migrations, like the contract and the table list, are read off the class, not derived by running it (`archive/design/plugins-as-layers.md` §7).

## BEH-EA-007: All static members are frozen for the lifetime of a plugin's options — options reach only Layers

```ts
static readonly config = (partial: Partial<PasswordConfigShape>) =>
  Layer.succeed(PasswordConfig, { ...PasswordConfig.defaultValue(), ...partial })
```

```text
REQUIREMENT: No value passed to a plugin's configuration Layer (`Password.config(...)`)
             MAY change the plugin's `id`, `apiVersion`, `contract`, or
             `tables` — configuration MUST be able to alter only what a
             `Layer` produces at `make`-time, never the plugin's static
             shape.
```

`research/13-modularity-foundations.md` frames this as the Parnas 1976 "program family" concern: the plugin contract is the family's shared design, frozen early, with everything that varies (hasher strength, mail provider, session lifetime) confined to the parts of the design meant to vary. `research/09-plugin-architecture.md`'s own recommended defaults state the litmus test directly: "if a toggle would add or remove an endpoint, table, migration, or hook point, it is an install decision," never a configuration one — which is exactly what keeping `contract`/`tables`/`migrations` static and options-immune is designed to guarantee.

## BEH-EA-008: `dependsOn` declares both ordering and a typed requirement in one static array

```ts
static readonly layer = AuthPlugin.layer(Password, {
  dependsOn: [Sessions, Users],
  make: Effect.gen(function*() { /* … */ }),
  handlers: PasswordHandlers
})
```

```text
REQUIREMENT: Every class listed in a plugin's `dependsOn` MUST join that
             plugin's Layer `RIn`, so that the dependency is simultaneously
             a migration-ordering fact for the linker and a compile-time
             requirement for every consumer of the plugin's Layer.
```

`archive/design/plugins-as-layers.md` §2.1 folds what earlier plugin systems kept as two separate declarations — a structural dependency list for ordering, and a service requirement for the type checker — into the single `dependsOn` array, because `AuthPlugin.layer`'s type signature (`DepsOf<typeof options>` joining `RIn`) makes the two facts equivalent by construction. `research/09-plugin-architecture.md` Q21 explicitly considers keeping `requiresPlugins` (structural) and `Context.Tag` requirements (service-level) as two mechanisms an author must maintain in parallel, and recommends against it for exactly this reason: Effect's own Layer graph already validates the tag-level requirement, so `dependsOn` only needs to add what the graph cannot express on its own — migration ordering.

_Next: [BEH-EA-009](02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple)_
