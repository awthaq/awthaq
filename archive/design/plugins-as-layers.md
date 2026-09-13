> **Superseded as the canonical specification by `spec/` (see `spec/README.md`).**
> Retained here as design rationale.

# Awthaq — Plugins as Layers

Version 0.3 — 2026-09-12. Replaces the plugin model of `design/api-design-v4.md` §8. The strata, contracts, qadi integration and everything else in v0.2 stay as they are; this document changes what a plugin *is* so that the type checker answers the questions a linker used to answer at boot.

Checked against `../effect` (v4 rc): `Context.Service` class instances carry a literal `key`, `Layer.Success` / `Layer.Error` / `Layer.Services` extract a layer's three channels, `HttpApiGroup.ToService<ApiId, Group>` is the service a handler layer provides, and `HttpApiBuilder.layer(api)` *requires* that service for every group.

---

## 0. The idea in one sentence

A plugin is a `Context.Service` class whose Layer provides the plugin itself, and whose requirements are other plugins and ports. Everything the old manifest declared is then already in the Layer's `RIn` and `ROut`, where the type checker reads it for free.

```
                    Layer<  ROut ,  E ,  RIn  >
plugin provides ──────────►│               │◄────────── plugin needs
  · itself (Password)      │               │   · other plugins (Sessions, Users)
  · its handler groups     │               │   · ports (PasswordHasher, Mailer)
  · slots it overrides     │               │   · hook points it taps
```

`Auth.make([Password, Passkey, Organization])` folds the tuple. What is required and not provided remains in `RIn`. The application's `Layer.launch` refuses to compile until it is provided. That is "did I miss a plugin" answered by the type system, with no linker involved.

---

## 1. What the type checker now catches

| Situation | Where it fails | How |
|---|---|---|
| Plugin B needs plugin A, A not installed | `Layer.launch` / `Effect.provide` | `A` remains in `RIn`; also `Auth.make` reports it by name (§4.2) |
| A port has no implementation (`Mailer`) | `Layer.launch` | `Mailer` remains in `RIn` |
| Contract added but handlers absent, or the reverse | impossible | `api` and `layer` come from the same tuple (§4.1) |
| Two plugins with the same id | `Auth.make` argument | `Validate<P>` |
| Two plugins override the same slot (`SubjectResolver`) | `Auth.make` argument | `Validate<P>`, pairwise on `ROut` |
| A plugin taps a hook point nobody defines | `Layer.launch` | the point's service remains in `RIn` |
| A group named outside the plugin's namespace | plugin definition | template-literal constraint on `contract` |
| A table named outside the plugin's prefix | plugin definition | template-literal constraint on `tables` |
| Plugin built for another Plugin API generation | `Auth.make` argument | `apiVersion: 1` literal |
| Two plugins implementing the same port | cannot happen | plugins *require* ports; only the application provides them (§3.3) |

Left to runtime, on purpose: a cycle in `dependsOn` (unrepresentable across ES modules anyway; the linker still checks), and migration order (derived from `dependsOn`, executed by the driver's `Migrator`).

---

## 2. Defining a plugin

### 2.1 The class

```ts
// @awthaq/password/src/Password.ts
import { AuthPlugin } from "@awthaq/core"
import { PasswordApi } from "./api.ts"

export interface PasswordShape {
  signUp(input: SignUpInput): Effect.Effect<User, PasswordError>
  signIn(input: SignInInput): Effect.Effect<User, PasswordError>
  requestReset(email: string): Effect.Effect<void>
  confirmReset(input: ResetInput): Effect.Effect<void, PasswordError>
}

export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", {
  apiVersion: 1,
  contract: PasswordApi,                 // groups must be named "password" or "password.<sub>"
  tables: ["password_account"],          // must start with "password_"
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Password, {
    dependsOn: [Sessions, Users],        // ordering + typed requirement, one declaration
    make: Effect.gen(function*() {
      const users = yield* Users
      const sessions = yield* Sessions
      const hasher = yield* PasswordHasher          // a port: RIn, never ROut
      const mailer = yield* Mailer
      const limiter = yield* RateLimiter.RateLimiter
      const config = yield* PasswordConfig          // options, as a service (§3.1)
      const hooks = yield* BeforeSignUp             // a hook point, as a service (§3.4)
      /* ... */
      return Password.of({ signUp, signIn, requestReset, confirmReset })
    }),
    handlers: PasswordHandlers            // HttpApiBuilder.group(PasswordContract, "password", …)
  })
}
```

What `AuthPlugin.Service` returns is a normal `Context.Service` class with typed statics. Application code depends on the plugin the way it depends on any service:

```ts
const password = yield* Password         // Effect<PasswordShape, never, Password>
yield* password.signIn(input)
```

### 2.2 The types behind it

```ts
export namespace AuthPlugin {
  // A group id is the plugin id or a dotted sub-id. Enforced where the contract is declared.
  type GroupsFor<Id extends string> = HttpApiGroup.HttpApiGroup<Id | `${Id}.${string}`, any, any>

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

  export interface Class<Self, Id extends string, Shape, Groups extends HttpApiGroup.Constraint>
    extends Context.ServiceClass<Self, `awthaq/plugin/${Id}`, Shape>
  {
    readonly id: Id
    readonly apiVersion: 1
    readonly contract: HttpApi.HttpApi<"auth", Groups>
    readonly tables: ReadonlyArray<`${Id}_${string}`>
    readonly migrations: Migrations
    readonly dependsOn: ReadonlyArray<Any>            // filled by AuthPlugin.layer
  }

  // The layer a plugin must expose. ROut is fixed by the class; E and RIn are whatever the author's code needs.
  export const layer = <P extends Any, E, R, HE = never, HR = never, TR = never>(
    plugin: P,
    options: {
      readonly dependsOn?: ReadonlyArray<Any>
      readonly make: Effect.Effect<P["Service"], E, R>
      readonly handlers?: Layer.Layer<HttpApiGroup.ToService<"auth", GroupsOf<P>>, HE, HR>
      readonly taps?: ReadonlyArray<Layer.Layer<never, never, TR>>       // hook taps, event subscriptions
    }
  ): Layer.Layer<
    P | HttpApiGroup.ToService<"auth", GroupsOf<P>>,
    E | HE,
    Exclude<R | HR | TR, Scope.Scope | P> | DepsOf<typeof options>   // dependsOn classes join RIn
  >

  export interface Any extends Class<any, string, any, HttpApiGroup.Constraint> {}
}
```

Everything after `Service` is plain `Layer` algebra. `AuthPlugin.layer` only does three things: `Layer.effect(plugin, make)`, `Layer.provideMerge` of the handlers so they see the plugin service, and `Layer.mergeAll` of the taps.

---

## 3. Richer plugin options, all as Layers

### 3.1 Configuration is a service with a default

Options are not constructor arguments. They are a `Context.Reference` the plugin reads; the application overrides it with a Layer. That makes options overridable per tenant, per test, or per environment with the same mechanism as everything else.

```ts
// @awthaq/password/src/Config.ts
export const PasswordConfig = Context.Reference<{
  readonly minLength: number
  readonly breachCheck: boolean | { readonly onUnavailable: "allow" | "reject" }
  readonly resetTtl: Duration.Duration
  readonly rehashOnLogin: boolean
}>("awthaq/password/Config", {
  defaultValue: () => ({ minLength: 12, breachCheck: false, resetTtl: Duration.hours(1), rehashOnLogin: true })
})

// sugar on the class
Password.config = (partial) => Layer.succeed(PasswordConfig, { ...PasswordConfig.defaultValue(), ...partial })
```

```ts
// application
Auth.make([Password, Passkey]).layer.pipe(
  Layer.provide(Password.config({ minLength: 16, breachCheck: { onUnavailable: "reject" } }))
)

// per tenant
export class TenantAuthConfig extends LayerMap.Service<TenantAuthConfig>()("app/TenantAuthConfig", {
  lookup: (tenant: string) => Layer.mergeAll(Password.config(tenantPolicy(tenant)), Sessions.config({ idle: tenantIdle(tenant) })),
  idleTimeToLive: "10 minutes"
}) {}
```

A missing override is never an error: the default applies. A *wrong* override is a type error against the reference's shape.

### 3.2 Variants are alternative layers

```ts
export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", { /* … */ }) {
  static readonly layer = AuthPlugin.layer(Password, { /* full */ })
  static readonly layerNoReset = AuthPlugin.layer(Password, { /* no mailer required; reset endpoints answer 404 */ })
}

Auth.make([Password.layerNoReset, Passkey])   // Auth.make accepts a class (its `.layer`) or a specific variant layer
```

`Mailer` disappears from `RIn` when you pick `layerNoReset`. You see the difference in the type of `auth.layer`.

### 3.3 Ports are required, never provided by plugins

The old design let a plugin "provide the hasher" and needed a conflict rule. Here a plugin declares `PasswordHasher` in `RIn`; the application provides it exactly once, at the top, with a plain `Layer.provide`. Two implementations in scope is a visible ordering choice in application code, not a plugin conflict. A "bcrypt plugin" is not a plugin at all; it is `BcryptHasher.layer`, which is what it should have been.

```ts
auth.layer.pipe(
  Layer.provide(PasswordHasher.layerArgon2id),
  Layer.provide(Mailer.layerSes)
)
```

### 3.4 Hook points are services

A hook point is a service holding a registry cell. Core provides the core points. A plugin that defines a point provides it. A plugin that taps a point requires it. Tapping a point that nothing defines is therefore a type error, not a silent no-op.

```ts
// core
export class BeforeSignUp extends HookPoint.Service<BeforeSignUp>()("auth.user.signUp", { kind: "veto", input: SignUpInput }) {}
export class AfterSignIn  extends HookPoint.Service<AfterSignIn>()("auth.signIn",       { kind: "observe", input: Session }) {}

// a plugin defining its own point
export class BeforeInvite extends HookPoint.Service<BeforeInvite>()("acme.invite.create", { kind: "veto", input: InviteInput }) {}

// tapping: Layer<never, never, BeforeSignUp>
const CompanyEmail = BeforeSignUp.tap((input) =>
  input.email.endsWith("@acme.com") ? Effect.succeed(input) : HookAbort.fail({ code: "EMAIL_DOMAIN_NOT_ALLOWED" }))
```

Veto points run taps in dependency order and may abort or amend; observe points isolate failures. Same semantics as v0.2, now with the point's existence checked at compile time.

### 3.5 Slots are references a plugin may override, exclusively

A slot is a `Context.Reference` with a fail-closed default. Overriding it means providing it in `ROut`. `Auth.make` refuses two plugins that override the same slot.

```ts
// core slots
export const SubjectResolver = Context.Reference<SubjectResolverShape>("awthaq/slot/SubjectResolver", { defaultValue: () => identityOnly })
export const SessionViewExtension = Context.Reference<(s: Session) => Effect.Effect<Record<string, unknown>>>("awthaq/slot/SessionViewExtension", { defaultValue: () => () => Effect.succeed({}) })

// the roles plugin overrides SubjectResolver
static readonly layer = AuthPlugin.layer(Roles, {
  make: /* … */,
  slots: [Layer.effect(SubjectResolver, resolverWithRoles)]        // joins ROut
})
```

If `Organization` also overrides `SubjectResolver`, `Auth.make([Roles, Organization])` fails with the two names. The fix is a plugin that composes both, or one that depends on the other and wraps its resolver.

### 3.6 Multi-contributions aggregate through registries

Where several plugins contribute to one thing, the thing is a registry service and contributions are `Layer.effectDiscard` writes: hook taps, event subscribers, rate-limit rules, session claims, OpenAPI tags. Ordering is dependency order, then declared `order`, then plugin id. The registry freezes at first read.

```ts
static readonly layer = AuthPlugin.layer(Invite, {
  make: /* … */,
  taps: [
    BeforeUserDelete.tap((u) => Invite.use((i) => i.purgeFor(u.id))),
    AuthEvents.on("auth.user.created", (e) => Invite.use((i) => i.markAccepted(e.userId))),
    RateLimits.rule({ group: "acme.invite", endpoint: "create", limit: 10, window: "10 minutes" }),
    SessionClaims.add((session) => Invite.use((i) => i.pendingCount(session.userId).pipe(Effect.map((n) => ({ pendingInvites: n })))))
  ]
})
```

---

## 4. `Auth.make`

### 4.1 One tuple, three outputs

```ts
export const make = <const P extends ReadonlyArray<AuthPlugin.Any | AuthPlugin.Variant>>(
  plugins: Auth.Validate<P>
): Auth.Built<P>

export interface Built<P extends ReadonlyArray<AuthPlugin.Any | AuthPlugin.Variant>> {
  readonly api: HttpApi.HttpApi<"auth", CoreGroups | GroupsOf<P[number]>>
  readonly layer: Layer.Layer<
    AuthCore | PluginOf<P[number]> | HttpApiGroup.ToService<"auth", CoreGroups | GroupsOf<P[number]>>,
    Layer.Error<LayerOf<P[number]>> | ConfigError,
    Exclude<Layer.Services<LayerOf<P[number]>>, AuthCore | PluginOf<P[number]> | SlotsOf<P[number]>>   // what is still missing
  >
  readonly migrations: Migrations           // core first, then plugins in dependsOn order, keys NNNN_<plugin>_<name>
  readonly manifest: Manifest               // for the CLI; derived, never authored
}
```

`api` and `layer` are computed from the same `P`, so a contract cannot be served without its handlers and handlers cannot exist for a group the contract lacks. That was a linker rule; now it is a fact about the return type.

### 4.2 `Validate<P>`

Pairwise checks over the tuple. Depth is the tuple length; a tuple of fifty plugins instantiates a few thousand types, which is nothing. No conditional types cross plugin *internals*; the checks read `id`, `ROut` and `RIn` only.

```ts
export type Validate<P extends ReadonlyArray<Any>> =
  DuplicateId<P> extends infer D extends string
    ? { readonly "awthaq": `plugin id "${D}" appears more than once` }
  : MissingDep<P> extends infer M extends [string, string]
    ? { readonly "awthaq": `plugin "${M[1]}" depends on plugin "${M[0]}", which is not in the list` }
  : SlotConflict<P> extends infer S extends [string, string, string]
    ? { readonly "awthaq": `slot "${S[0]}" is overridden by both "${S[1]}" and "${S[2]}"` }
  : P

// helpers (shape only)
type Ids<P>          = P[number]["id"]
type DuplicateId<P>  = /* walk the tuple; first id seen twice, else never */ never
type PluginDeps<X>   = Extract<Layer.Services<LayerOf<X>>, { readonly key: `awthaq/plugin/${string}` }>   // plugin requirements only
type MissingDep<P>   = /* first [depId, byId] where depId ∉ Ids<P>, else never */ never
type SlotConflict<P> = /* first [slotKey, a, b] with slotKey ∈ ROut of both, else never */ never
```

Because a plugin requirement is a service whose instance type carries `key: "awthaq/plugin/<id>"`, `MissingDep` can *name* the missing plugin instead of leaving you with a bare unsatisfied `RIn`. Both happen: the named error at `Auth.make`, and the structural one at `Layer.launch` if you bypass `Auth.make`.

### 4.3 What the compiler says

```ts
const auth = Auth.make([TwoFactor, Passkey])
```
```
error TS2345: Argument of type '[typeof TwoFactor, typeof Passkey]' is not assignable to parameter of type
  '{ readonly "awthaq": "plugin \"two-factor\" depends on plugin \"password\", which is not in the list"; }'.
```

```ts
const auth = Auth.make([Password, Passkey])
Layer.launch(HttpRouter.serve(Routes).pipe(Layer.provide(auth.layer), Layer.provide(NodeHttpServer.layer(...))))
```
```
error TS2345: Argument of type 'Layer<never, ConfigError | SqlError, Mailer | PasswordHasher | SqlClient>' is not assignable
  to parameter of type 'Layer<never, unknown, never>'.
    Type 'Mailer | PasswordHasher | SqlClient' is not assignable to type 'never'.
```
Three ports still to provide, named.

```ts
const auth = Auth.make([Roles, Organization])
```
```
error TS2345: … '{ readonly "awthaq": "slot \"awthaq/slot/SubjectResolver\" is overridden by both \"roles\" and \"organization\""; }'
```

```ts
export class Invite extends AuthPlugin.Service<Invite, InviteShape>()("acme.invite", {
  apiVersion: 1,
  contract: HttpApi.make("auth").add(HttpApiGroup.make("invitations").add(/* … */))
})
```
```
error TS2322: Type 'HttpApiGroup<"invitations", …>' is not assignable to type 'HttpApiGroup<"acme.invite" | `acme.invite.${string}`, any, any>'.
```

---

## 5. The application

```ts
// app/auth.ts
import { Auth, Sessions, SessionConfig } from "@awthaq/core"
import { Password } from "@awthaq/password"
import { Passkey } from "@awthaq/passkey"
import { OAuth, Google, GitHub } from "@awthaq/oauth"
import { Organization } from "@awthaq/organization"
import { Roles } from "@awthaq/roles"
import { PasswordHasher, Mailer } from "@awthaq/ports"
import { RateLimiter, KeyValueStore } from "effect/unstable/persistence"
import { PgClient, PgMigrator } from "@effect/sql-pg"

export const auth = Auth.make([Password, Passkey, OAuth, Organization, Roles])
//    auth.api   : HttpApi<"auth", CoreGroups | PasswordGroups | PasskeyGroups | OAuthGroups | OrganizationGroups | RolesGroups>
//    auth.layer : Layer<AuthCore | Password | Passkey | …, ConfigError | SqlError,
//                       PasswordHasher | Mailer | WebAuthn | RateLimiter | KeyValueStore | SqlClient | Crypto>
//                                                  ↑ exactly what is still yours to provide

export const AuthLive = auth.layer.pipe(
  Layer.provide(Password.config({ minLength: 14, breachCheck: true })),
  Layer.provide(Sessions.config({ absolute: Duration.days(7), idle: Duration.days(1) })),
  Layer.provide(OAuth.providers([Google, GitHub])),           // providers are Layers too; secrets via Config inside them
  Layer.provide(Roles.graph([member, admin])),
  Layer.provide(PasswordHasher.layerArgon2id),
  Layer.provide(Mailer.layerSes),
  Layer.provide(WebAuthn.layerSimpleWebAuthn({ rpId: "example.com", origins: ["https://example.com"] })),
  Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreRedisConfig({ url: Config.Redacted("REDIS_URL") })))),
  Layer.provide(KeyValueStore.layerMemory),
  Layer.provide(PgMigrator.layer({ loader: PgMigrator.fromRecord(auth.migrations) }).pipe(
    Layer.provideMerge(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })))),
  Layer.provide(NodeServices.layer)
)
// AuthLive : Layer<AuthCore | Password | Passkey | OAuth | Organization | Roles | …, ConfigError | SqlError, never>
```

Remove the `Mailer.layerSes` line and `AuthLive` no longer has `never` in its third slot; `Layer.launch` refuses it. Add `TwoFactor` to the tuple and forget `Password`, and `Auth.make` refuses it by name. Nothing here runs before the type checker is satisfied.

Application code depends on plugins as services, so an accidental dependency on an uninstalled plugin fails the same way:

```ts
const invite = Effect.gen(function*() {
  const org = yield* Organization                  // Effect<…, …, Organization>
  yield* org.invite(orgId, email)
})
// provided by auth.layer only when Organization is in the tuple
```

---

## 6. Core is built the same way

`AuthCore` is not special. It is the fold of a fixed tuple of first-party plugins that `Auth.make` prepends:

```ts
export const core = [Users, Accounts, Sessions, Verification, Authentication, Csrf, SessionView] as const
export const make = (plugins) => build([...core, ...plugins])
```

`Sessions` is a plugin with a contract (the `session` group), a table (`sessions_session`), migrations, a config reference and a layer. Third-party plugins depend on it through `dependsOn: [Sessions]` exactly as they depend on each other. The only privilege core has is that its groups sit at the root of `/auth` and its ids are reserved.

---

## 7. What the linker still does

`Auth.make` also runs a tiny runtime step, because two facts are not representable in types:

- **Cycle detection** over `dependsOn`, Kahn's algorithm, with the full path in the error. A cycle is nearly impossible to write (it needs a circular import of class values) but the check is five lines.
- **Migration ordering**: core first, then plugins in topological order, re-keyed `NNNN_<plugin>_<name>`; hash-stamped so the CLI can tell you the plugin set changed.

It also derives `manifest` for the CLI (`plugin list --graph`, `routes`, `schema`). Nothing in `manifest` is authored; it is read off the classes.

---

## 8. Writing a third-party plugin, complete

```ts
// packages/awthaq-invite/src/api.ts   — isomorphic
export class InviteApi extends HttpApiGroup.make("acme.invite")
  .add(
    HttpApiEndpoint.post("create", "/", { payload: { email: Email, role: Schema.Literals(["member", "admin"]) }, success: InviteCreated, error: [RateLimited] })
      .pipe((e) => e.annotate(RequiredPermission, requiresPermission(e, { permission: project.invite, policy: hasPermission(project.invite) }))),
    HttpApiEndpoint.post("accept", "/:token/accept", { params: { token: Schema.RedactedFromValue(Schema.String) }, success: SessionView, error: [InviteNotFound, InviteExpired] })
      .pipe((e) => e.annotate(PublicEndpoint, publicEndpoint("the invitee has no account yet")))
  )
  .middleware(Authentication).middleware(RequirePermission).middleware(CsrfProtection)
  .prefix("/invite")
{}
export class InviteContract extends HttpApi.make("auth").add(InviteApi) {}
```

```ts
// packages/awthaq-invite/src/Invite.ts   — server
export const InviteConfig = Context.Reference<{ readonly ttl: Duration.Duration }>("acme/invite/Config", {
  defaultValue: () => ({ ttl: Duration.days(7) })
})

export class BeforeInvite extends HookPoint.Service<BeforeInvite>()("acme.invite.create", { kind: "veto", input: InviteInput }) {}

export class Invite extends AuthPlugin.Service<Invite, {
  create(input: InviteInput): Effect.Effect<Invitation, InviteError>
  accept(token: Redacted.Redacted<string>): Effect.Effect<User, InviteError>
  purgeFor(userId: UserId): Effect.Effect<void>
}>()("acme.invite", {
  apiVersion: 1,
  contract: InviteContract,
  tables: ["acme.invite_invitation"],
  migrations
}) {
  static readonly config = (c: Partial<typeof InviteConfig.Service>) => Layer.succeed(InviteConfig, { ...InviteConfig.defaultValue(), ...c })

  static readonly layer = AuthPlugin.layer(Invite, {
    dependsOn: [Password, Users, Sessions],
    provides: [BeforeInvite],                              // a hook point others may tap
    make: Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const repo = yield* SqlModel.makeRepository(Invitation, { tableName: "acme.invite_invitation", spanPrefix: "Invite", idColumn: "id" })
      const crypto = yield* Crypto.Crypto
      const mailer = yield* Mailer
      const limiter = yield* RateLimiter.RateLimiter
      const config = yield* InviteConfig
      const before = yield* BeforeInvite
      const password = yield* Password
      /* … */
      return Invite.of({ create, accept, purgeFor })
    }),
    handlers: InviteHandlers,
    taps: [
      BeforeUserDelete.tap((u) => Invite.use((i) => i.purgeFor(u.id))),
      AuthEvents.on("auth.user.created", (e) => Invite.use((i) => i.markAccepted(e.userId)))
    ]
  })
}
// Invite.layer : Layer<Invite | BeforeInvite | HttpApiGroup.Service<"auth","acme.invite">, never,
//                      Password | Users | Sessions | BeforeUserDelete | AuthEvents | SqlClient | Crypto | Mailer | RateLimiter>
```

```ts
// an app installs it
const auth = Auth.make([Password, Invite])
auth.layer.pipe(Layer.provide(Invite.config({ ttl: Duration.days(3) })), /* ports … */)
```

Install it without `Password` and `Auth.make` names the missing plugin. Install it and forget `Mailer` and `Layer.launch` names the missing port. Tap `BeforeInvite` from another plugin without installing `Invite` and that plugin's layer carries `BeforeInvite` in `RIn` until you do.

---

## 9. Trade-offs, stated

- **Type-level cost.** `Validate<P>` is pairwise over the tuple. Fifty plugins is fine; five hundred is not, and nobody installs five hundred. Nothing recurses into plugin internals, so IDE latency tracks the number of plugins, not their size.
- **Error messages.** `Auth.make` errors are readable strings. `Layer.launch` errors are Effect's usual "X is not assignable to never" listing the missing services by class name, which is what you want once you have read one.
- **Options are services.** Slightly more ceremony than `password({ minLength: 12 })`, repaid the first time you need a per-tenant or per-test override. The factory form can be kept as sugar that returns a `Variant` bundling `layer` with a config Layer.
- **Ports are never provided by plugins.** This removes a whole conflict class and matches how Effect applications already wire databases and clients. A plugin that *is* a port implementation ships as a Layer, not as a plugin.
- **Slots are exclusive by construction; registries aggregate.** The two are different services on purpose, so the type of a contribution tells you whether it can conflict.
- **The linker did not disappear.** It shrank to cycle detection and migration ordering, and it produces the CLI manifest. It no longer stands between you and a type error.
