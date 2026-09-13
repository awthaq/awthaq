> **Superseded by `design/plugins-as-layers.md` (v0.3, `AuthPlugin.Service`), itself now superseded by `spec/behaviors/01-plugin-contract.md` and `spec/behaviors/02-plugin-composition-validate.md`.**
> Kept for the research trace only — do not use `definePlugin` as current API guidance.

# Effect Auth — API Design Proposal

Version 0.1 — 2026-09-12. Synthesizes `PRD.md`, `research/01..18` and the `better-auth/` contract corpus into one concrete public API. Every shape below is traceable to a research finding; the trace is in §12.

Target: `effect@^3.22`, `@effect/platform` HttpApi, `@effect/sql`. Idioms are v3 (`Context.Tag`, `Effect.Service`, `Layer`, `Schema.TaggedError`, `HttpApiMiddleware.Tag`). The `@effect-auth/*` scope is a placeholder; it is taken on npm (research 01) and the rename is a pending decision.

---

## 0. The seven laws, as API constraints

The review article (research 18) derived seven design laws. Each one fixes a piece of the API surface:

| Law | What it forces in the API |
|---|---|
| 1. Freeze the design rules early | `definePlugin` requires only `id` + `apiVersion`; every other field is optional and declarative; the returned record is frozen |
| 2. Compile, don't document | `Auth.compile` is a real compiler: dependencies, capabilities, routes, schema, hook legality are *errors with codes*, never docs |
| 3. Detect interactions offline, resolve by declared policy | Route keys, schema columns, migration order and hook vetoes are validated at compile; ordering is topo → `order` → id, never registration order |
| 4. Treat the plugin set as a product line | `Auth.define({ plugins })` is the configurator; capabilities are the feature diagram; config can never add a route, table or hook point |
| 5. Trust measurements, not declarations | `@effect-auth/test` ships `runPluginContractTests`; `apiVersion` is an integer exact-match gate |
| 6. Deprecate = minor + codemod | Plugin API ships as `apiVersion: 1`; hosts support current + previous generation |
| 7. Least privilege before isolation | Plugins depend on *capabilities* (`PasswordHasher`), never on other plugins' internals; exclusivity is compiler-enforced; Wasm sandbox is a documented v2 seam |

Two structural rules from the Effect research (01, 09) shape everything else:

- **Two graphs.** The *plugin graph* (ids, deps, capabilities, routes, schema IR, hook order) is data the compiler validates and the CLI prints. The *service graph* is Effect `Layer`s the compiler never looks inside. Plugins ship both halves.
- **The type system never reasons about the graph.** `Auth.define` is generic only over the plugin tuple; all derived types are shallow indexed accesses (`Plugins[number]["Provides"]`). No conditional-type merging, no TS2589 cliff.

---

## 1. Package map

```
@effect-auth/core        Auth, definePlugin, Capability, Principal, Sessions, Users, Authorizer,
                         HookPoint, AuthEvent, Table/Column, AuthError, Permissions
@effect-auth/http        AuthHttp (serve), Authenticated/Authorized middleware, cookies, CSRF, OpenAPI
@effect-auth/sql         SqlStore (AuthStore over @effect/sql), migration engine
@effect-auth/sql-pg      DDL dialect
@effect-auth/sql-sqlite  DDL dialect (node + wasm)
@effect-auth/memory      MemoryStore (tests, prototyping)
@effect-auth/client      AuthClient (HttpApiClient-derived)
@effect-auth/react       useSession, AuthClientProvider (on @effect-atom/atom-react)
@effect-auth/test        TestAuth, runPluginContractTests
@effect-auth/cli         effect-auth doctor | schema | migration | plugin | routes | openapi

@effect-auth/password    official plugins; each also exports "./api" (isomorphic contract, no server code)
@effect-auth/oauth
@effect-auth/passkey
@effect-auth/magic-link
```

Three audiences, three surfaces:

| Audience | Uses |
|---|---|
| Application developer | `Auth.define` · core services · `Authenticated` middleware · `AuthClient` |
| Plugin author | `definePlugin` · `Capability` · `HookPoint` · `AuthEvent` · `Table` · `AuthError` |
| Adapter author | `AuthStore` interface · `Dialect` interface · the adapter contract tests |

---

## 2. Application surface

### 2.1 Minimal app

```ts
// auth.ts
import { Auth } from "@effect-auth/core"
import { password } from "@effect-auth/password"
import { SqlStore } from "@effect-auth/sql"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"

export const auth = Auth.define({
  plugins: [password()]
})

export const AuthLive = auth.layer.pipe(
  Layer.provide(SqlStore.layer),
  Layer.provide(PgClient.layer({ url: Config.redacted("DATABASE_URL") }))
)
```

`Auth.define` returns an `AuthDefinition`, a small object the whole toolchain shares:

```ts
interface AuthDefinition<Plugins extends ReadonlyArray<Plugin.Any>> {
  readonly layer: Layer.Layer<
    AuthRuntime | Plugin.Provides<Plugins[number]>,   // core services + every plugin's public services
    PluginCompileError | ConfigError,                 // fails at build, before the first request
    AuthStore | Plugin.Requires<Plugins[number]>      // adapter port + anything a plugin needs from the host
  >
  readonly api: AuthApi<Plugins>                      // one HttpApi: core groups + every plugin group
  readonly compile: Effect.Effect<CompiledAuth, PluginCompileError>   // pure; the CLI uses it without a DB
  readonly manifest: AuthManifest                     // resolved plugin graph, printable
}
```

Everything that follows hangs off this one object.

### 2.2 Full configuration

```ts
import { Auth } from "@effect-auth/core"
import { password } from "@effect-auth/password"
import { oauth, google, github } from "@effect-auth/oauth"
import { passkey } from "@effect-auth/passkey"
import { organization } from "@effect-auth/organization"
import { Duration } from "effect"

export const auth = Auth.define({
  basePath: "/auth",

  session: {
    absolute: Duration.days(30),          // never extended
    idle: Duration.days(7),               // sliding, refresh throttled
    cookie: { name: "__Host-session", sameSite: "strict" }
  },

  security: {
    csrf: "signed-double-submit",         // default; "synchronizer" | "off" (bearer-only deployments)
    trustedOrigins: ["https://app.example.com"]
  },

  plugins: [
    password({ minLength: 12, breachCheck: true }),
    oauth({
      providers: [google(), github()],   // provider *values*; secrets resolved inside the plugin layer
      linking: "explicit"                 // default; "trusted-providers" opt-in
    }),
    passkey({ rpId: "example.com", origins: ["https://example.com"] }),
    organization()
  ]
})
```

Rules the config obeys, enforced by `Auth.compile` and a contract test:

- Structural config is a plain object, Schema-validated once at compile.
- Secrets never appear here. `google()` reads `AUTH_OAUTH_GOOGLE_CLIENT_SECRET` via `Config.redacted` inside its layer.
- Config cannot change the route table, the schema IR or the hook-point set. Enabling something not installed fails at boot with `E_CAPABILITY_NOT_INSTALLED`.

### 2.3 Using auth in-process

Plugins expose ordinary Effect services. There is no synthesized facade type; the "facade whose keys depend on installed plugins" is the Layer's provided set.

```ts
import { CurrentPrincipal, Sessions, Authorizer } from "@effect-auth/core"
import { Password } from "@effect-auth/password"

const signIn = Effect.gen(function* () {
  const password = yield* Password              // present only if password() is installed — the type says so
  const session = yield* password.signIn({ email, password: secret })
  return session
})
// Effect<Session, InvalidCredentials | RateLimited | HookAborted, Password>

const deleteProject = (id: ProjectId) => Effect.gen(function* () {
  const principal = yield* CurrentPrincipal    // provided by the auth middleware
  const project = yield* Projects.byId(id)
  yield* Authorizer.require(perms.project.delete, project)   // deny by default, typed Forbidden | ResourceNotFound
  yield* Projects.remove(id)
})
```

Core services (always present):

| Service | Shape |
|---|---|
| `CurrentPrincipal` | `Principal` for the current request; absent outside a request |
| `Sessions` | `create`, `current`, `require`, `revoke`, `revokeOthers`, `list(userId)` |
| `Users` | `byId`, `byEmail`, `create`, `update`, `delete`; profile only, never credentials |
| `Accounts` | `link`, `unlink` (refuses to remove the last credential), `listByUser` |
| `Verification` | purpose-scoped single-use tokens: `issue`, `consume` |
| `Authorizer` | `check`, `require`, `filter`, `authorizedActions` |
| `AuthEvents` | `publish`, `subscribe` |
| `AuthManifest` | the compiled plugin graph, for tooling |

### 2.4 Serving HTTP

```ts
import { AuthHttp } from "@effect-auth/http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { createServer } from "node:http"

// Option A: the whole server is Effect
const Server = HttpApiBuilder.serve().pipe(
  Layer.provide(AuthHttp.layer(auth)),              // handlers for every plugin group + core groups
  Layer.provide(AuthLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)
NodeRuntime.runMain(Layer.launch(Server))

// Option B: a web handler for Next.js / Hono / TanStack / anything Request → Response
export const { handler } = AuthHttp.toWebHandler(auth, AuthLive)
```

`AuthHttp.layer` mounts everything under `basePath`:

```
POST /auth/sign-out              core
GET  /auth/session               core
POST /auth/password/sign-up      plugin "password"  (prefix = plugin id, compiler-injected)
POST /auth/password/sign-in
GET  /auth/oauth/:provider/authorize
GET  /auth/oauth/:provider/callback
POST /auth/passkey/register/options
POST /auth/organization/invitations
```

### 2.5 Protecting your own endpoints

The auth middleware is an exported `HttpApiMiddleware`, so your API reuses it directly. Nothing about your API is special-cased.

```ts
import { Authenticated, Authorized } from "@effect-auth/http"

const ProjectsApi = HttpApiGroup.make("projects")
  .add(HttpApiEndpoint.del("delete", "/projects/:id").setPath(Schema.Struct({ id: ProjectId })))
  .middleware(Authenticated)                              // provides CurrentPrincipal, fails Unauthenticated

const AdminApi = HttpApiGroup.make("admin")
  .add(HttpApiEndpoint.get("stats", "/admin/stats"))
  .middleware(Authorized(perms.admin.access))             // resource-less coarse gate

const ProjectsLive = HttpApiBuilder.group(AppApi, "projects", (h) =>
  h.handle("delete", ({ path }) => deleteProject(path.id)) // resource-level check lives in the handler (§2.3)
)
```

### 2.6 Authorization

```ts
import { Permissions, Policy } from "@effect-auth/core"

export const perms = Permissions.make("app", {
  project: ["create", "update", "delete"],
  billing: ["view"]
} as const)
// perms.project.delete : PermissionName<"project:delete">  — a typo is a compile error

const canManage = Policy.all(
  Policy.memberOf((ctx) => ctx.resource.orgId),
  Policy.any(Policy.owns(Project), Policy.hasRole("admin")),
  Policy.not(Policy.suspended)
)

yield* Authorizer.require(perms.project.update, project, { policy: canManage })
```

Semantics are fixed once: deny by default, `all` short-circuits on first false, `any` on first true, explicit `forbid` beats allow. `Forbidden` and `ResourceNotFound` are distinct errors; the wire mapping is per route (`notFoundOnDeny: true` for id-addressable cross-tenant resources).

### 2.7 Swapping a capability

Capabilities are `Effect.Service` classes with a safe `.Default`. Swapping is a Layer operation the app does explicitly; the compiler refuses two exclusive providers.

```ts
import { PasswordHasher } from "@effect-auth/core"

export const AuthLive = auth.layer.pipe(
  Layer.provide(BcryptHasher.layer),     // overrides the argon2id default for auth.hasher
  Layer.provide(SqlStore.layer),
  Layer.provide(PgClient.layer(...))
)
```

Test doubles are the same mechanism: `Layer.succeed(Mailer, recordingMailer)`.

### 2.8 Multi-tenant seam

Installation is code; configuration is data. A tenant may select among installed capabilities, never add one.

```ts
import { TenantConfig } from "@effect-auth/core"

const TenantsLive = TenantConfig.layerMap({
  lookup: (tenantId) => TenantRepo.load(tenantId),   // Effect<TenantSettings>
  idleTimeToLive: Duration.minutes(10)
})
// TenantSettings is validated against auth.manifest at boot:
//   { oauth: { providers: ["google"] } }         ok, google() is installed
//   { smsOtp: { enabled: true } }                E_CAPABILITY_NOT_INSTALLED — fail closed
```

Built on `LayerMap` (present since effect 3.14). The seam ships in v1 as an interface; per-tenant provider *credentials* are the first consumer.

---

## 3. Plugin author surface

### 3.1 `definePlugin`

The contract is a frozen record with two halves: a **static half** the compiler and CLI can read without executing anything (the VS Code `contributes` model), and a **runtime half** built from validated options (the `activate` model).

```ts
export interface PluginSpec<
  Id extends string,
  Options,
  OptionsInput,
  Provides,                       // union of Context tags the plugin's layer exposes publicly
  Requires,                       // union of tags the layer needs from the host
  Api extends HttpApiGroup.Any | never
> {
  // ── identity (the only required fields) ──────────────────────────────
  readonly id: Id                          // "password" (official) | "acme.invite" (third party: npm scope prefix)
  readonly apiVersion: 1                   // exact-match against host generations {1}; else E_API_VERSION_UNSUPPORTED
  readonly version?: string                // semver, informational

  // ── plugin graph (declarative) ────────────────────────────────────────
  readonly requires?: {
    readonly plugins?: ReadonlyArray<string>               // structural deps: ordering, migrations, FK targets
    readonly capabilities?: ReadonlyArray<Capability.Any>  // authority deps: any provider will do
  }
  readonly provides?: ReadonlyArray<Capability.Of<Provides>>  // exclusive capabilities implemented by `layer`
  readonly conflicts?: ReadonlyArray<string>                  // plugin ids that may not coexist

  // ── options ───────────────────────────────────────────────────────────
  readonly options?: Schema.Schema<Options, OptionsInput>    // validated once at Auth.compile

  // ── static contributions (inspectable without options) ────────────────
  readonly api?: Api                                   // HttpApiGroup; mounted at /<id> by the compiler
  readonly schema?: {
    readonly tables?: ReadonlyArray<Table.Any>         // physical name = <id>_<table>
    readonly extends?: { readonly user?: ScalarColumns; readonly session?: ScalarColumns }
  }
  readonly events?: ReadonlyArray<AuthEvent.Class>     // Schema classes this plugin may publish
  readonly permissions?: Permissions.Set               // namespaced by id; typo-proof constants
  readonly hookPoints?: ReadonlyArray<HookPoint.Any>   // new lifecycle points others may tap
  readonly rateLimit?: ReadonlyArray<RateLimitRule>    // only on this plugin's own endpoints

  // ── runtime contributions (see options) ───────────────────────────────
  readonly make: (options: Options) => {
    readonly layer: Layer.Layer<Provides, ConfigError, Requires | AuthStore | Clock>
    readonly handlers?: Handlers<Api>                  // HttpApiBuilder group for `api`
    readonly hooks?: ReadonlyArray<HookTap.Any>        // taps on core or other plugins' hook points
    readonly subscriptions?: ReadonlyArray<EventSubscription.Any>
    readonly strategies?: ReadonlyArray<AuthStrategy>  // credential → principal resolvers
    readonly middleware?: ReadonlyArray<MiddlewareContribution>
  }
}

export const definePlugin: <...>(spec: PluginSpec<...>) => PluginDefinition<...>
// PluginDefinition is callable: password({ minLength: 12 }) → Plugin (frozen instance)
```

Why the split matters: `effect-auth plugin list`, `doctor`, `schema`, docs generation and the registry validator all run on the static half alone. Options can parameterize behaviour, never shape. The contract test asserts it: two instances with different options compile to the same manifest hash.

### 3.2 Smallest plugin: a sign-up policy (hooks only)

```ts
import { definePlugin, Hooks, HookAbort } from "@effect-auth/core"

export const companyEmail = definePlugin({
  id: "acme.company-email",
  apiVersion: 1,

  make: () => ({
    layer: Layer.empty,
    hooks: [
      Hooks.beforeSignUp.tap(({ input }) =>
        input.email.endsWith("@acme.com")
          ? Effect.void
          : HookAbort.fail({ code: "EMAIL_DOMAIN_NOT_ALLOWED", message: "Use your company address." })
      )
    ]
  })
})

// install
Auth.define({ plugins: [password(), companyEmail()] })
```

`beforeSignUp` is a *veto* point: taps run in resolved order, may abort with a typed `HookAbort` (mapped to 4xx with a stable code) or amend the input. `after*` points cannot abort; the compiler wraps them so a failing observer logs and counts but never fails sign-up.

### 3.3 A full plugin: invitations

Everything a plugin can contribute, in one file. Comments mark the compiler rules each part triggers.

```ts
// packages/plugin-invite/src/api.ts  — isomorphic; also exported as "@acme/effect-auth-invite/api"
import { AuthApi, AuthError } from "@effect-auth/core"
import { HttpApiEndpoint, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

export class InviteNotFound extends AuthError("InviteNotFound", { status: 404 })({}) {}
export class InviteExpired  extends AuthError("InviteExpired",  { status: 410 })({}) {}

export const InviteApi = AuthApi.group("invite")            // group name = plugin id; prefix /invite injected
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(Schema.Struct({ email: Schema.String, role: Schema.Literal("member", "admin") }))
      .addSuccess(Schema.Struct({ id: Schema.String, expiresAt: Schema.DateTimeUtc }))
  )
  .add(
    HttpApiEndpoint.post("accept", "/:token/accept")
      .setPath(Schema.Struct({ token: Schema.Redacted(Schema.String) }))
      .addSuccess(Schema.Struct({ userId: Schema.String }))
      .addError(InviteNotFound)
      .addError(InviteExpired)
  )
```

```ts
// packages/plugin-invite/src/index.ts — server
import {
  definePlugin, Capabilities, Table, Column, Index, AuthEvent, Permissions,
  Hooks, HookPoint, AuthStore, Users, Verification, Mailer, CurrentPrincipal, Authorizer
} from "@effect-auth/core"
import { Authenticated } from "@effect-auth/http"
import { InviteApi, InviteNotFound, InviteExpired } from "./api.js"

// ── schema: a side table, auto-prefixed to invite_invitation ────────────
export const Invitation = Table.make("invitation", {
  id:        Column.id(),
  email:     Column.string(320),
  role:      Column.enum(["member", "admin"]),
  tokenHash: Column.string(64, { unique: true }),   // secret hashed at rest, like every core token
  invitedBy: Column.ref(Users.Table, { onDelete: "set null" }),
  expiresAt: Column.timestamp(),
  acceptedAt: Column.timestamp({ nullable: true }),
  createdAt: Column.createdAt()
}, {
  indexes: [Index.on("email"), Index.on("expiresAt")]
})

// ── events: Schema classes; redaction is in the type ──────────────────
export class InviteCreated extends AuthEvent("invite.created")({
  invitationId: Schema.String,
  email: Schema.Redacted(Schema.String)
}) {}
export class InviteAccepted extends AuthEvent("invite.accepted")({
  invitationId: Schema.String,
  userId: Schema.String
}) {}

// ── permissions: namespaced, typo-proof ───────────────────────────────
export const perms = Permissions.make("invite", { invitation: ["create", "revoke"] } as const)

// ── a hook point other plugins may tap (e.g. captcha, org quotas) ─────
export const beforeInvite = HookPoint.before("invite.create", {
  input: Schema.Struct({ email: Schema.String, role: Schema.String })
})

// ── options ───────────────────────────────────────────────────────────
const Options = Schema.Struct({
  ttl: Schema.optionalWith(Schema.DurationFromSelf, { default: () => Duration.days(7) })
})

// ── the service the plugin exposes to app code ────────────────────────
export class Invites extends Effect.Service<Invites>()("@acme/effect-auth-invite/Invites", {
  effect: Effect.gen(function* () {
    const store = yield* AuthStore
    const invitations = store.table(Invitation)          // typed repository: byId, findOne, insert, update, list(keyset)
    const verification = yield* Verification
    const mailer = yield* Mailer                          // capability, not a concrete mailer
    const events = yield* AuthEvents
    const hooks = yield* Hooks

    const create = (input: { email: string; role: "member" | "admin" }, ttl: Duration.Duration) =>
      Effect.gen(function* () {
        const amended = yield* hooks.run(beforeInvite, input)              // veto point
        const { token, hash } = yield* Verification.mintToken()            // id.secret, SHA-256 hash
        const row = yield* invitations.insert({ ...amended, tokenHash: hash, expiresAt: /* clock + ttl */ })
        yield* mailer.send({ to: amended.email, template: "invite", data: { token } })
        yield* events.publish(new InviteCreated({ invitationId: row.id, email: Redacted.make(amended.email) }))
        return row
      }).pipe(Effect.withSpan("auth.invite.create"))

    return { create, accept: /* ... consumes token in the same transaction */ } as const
  })
}) {}

// ── the plugin ────────────────────────────────────────────────────────
export const invite = definePlugin({
  id: "acme.invite",                       // third-party namespace derived from the npm scope
  apiVersion: 1,
  version: "1.0.0",

  requires: {
    plugins: ["password"],                 // accept must create a password account → ordering + FK guarantee
    capabilities: [Capabilities.mailer]    // any Mailer implementation satisfies this
  },
  options: Options,

  api: InviteApi,
  schema: { tables: [Invitation] },
  events: [InviteCreated, InviteAccepted],
  permissions: perms,
  hookPoints: [beforeInvite],
  rateLimit: [{ endpoint: "create", limit: 10, window: Duration.minutes(10) }],   // own endpoints only

  make: (options) => ({
    layer: Invites.Default,

    handlers: InviteApi.handlers((h) =>
      h.handle("create", ({ payload }) => Effect.gen(function* () {
        yield* Authorizer.require(perms.invitation.create)            // resource-less: middleware could do it too
        const invites = yield* Invites
        return yield* invites.create(payload, options.ttl)
      }))
       .handle("accept", ({ path }) => Effect.gen(function* () {
        const invites = yield* Invites
        return yield* invites.accept(path.token)
      }))
    ),

    middleware: [{ endpoints: ["create"], use: Authenticated }],   // per-endpoint; "accept" stays public

    subscriptions: [
      AuthEvents.on(UserDeleted, ({ userId }) => /* cascade cleanup */ Effect.void)
    ]
  })
})
```

Compiler checks this plugin triggers: `E_PLUGIN_MISSING_DEP` if `password()` is absent; `E_CAPABILITY_MISSING` if no `Mailer` layer is provided; `E_ROUTE_CONFLICT` if another plugin claims `POST /invite/`; `E_SCHEMA_CONFLICT` if `invite_invitation` already exists; `E_NAMESPACE_RESERVED` had the id been `auth.invite`.

### 3.4 An authentication strategy: bearer tokens

Strategies are declarative contributions to the core `Authentication` chain. The chain is ordered at compile (topo → `order` → id), first match wins, a presented-but-invalid credential is a typed error rather than a fall-through.

```ts
import { definePlugin, AuthStrategy, Sessions, CredentialInvalid } from "@effect-auth/core"

export const bearer = definePlugin({
  id: "bearer",
  apiVersion: 1,

  make: () => ({
    layer: Layer.empty,
    strategies: [
      AuthStrategy.make({
        id: "bearer",
        order: 20,                                   // after the cookie strategy (order 0), before api keys (order 40)
        csrf: "exempt",                              // no ambient credential
        resolve: ({ headers }) => Effect.gen(function* () {
          const raw = headers["authorization"]
          if (!raw?.startsWith("Bearer ")) return Option.none()        // credential absent → next strategy
          const sessions = yield* Sessions
          const session = yield* sessions.verifyToken(raw.slice(7)).pipe(
            Effect.mapError(() => new CredentialInvalid({ strategy: "bearer" }))   // present but bad → stop
          )
          return Option.some({ principal: session.principal, sessionId: session.id })
        })
      })
    ]
  })
})
```

### 3.5 A capability provider: bcrypt hasher

Exclusive capabilities are implemented as a Layer and declared in `provides`. Two providers in one app is `E_CAPABILITY_CONFLICT` naming both plugins.

```ts
import { definePlugin, Capabilities, PasswordHasher } from "@effect-auth/core"

const BcryptHasherLive = Layer.effect(PasswordHasher, Effect.gen(function* () {
  const cost = yield* Config.integer("AUTH_BCRYPT_COST").pipe(Config.withDefault(12))
  return PasswordHasher.of({
    hash:   (plain) => /* ... */,
    verify: (plain, phc) => /* constant-time */,
    needsRehash: (phc) => /* parse cost */
  })
}))

export const bcryptHasher = definePlugin({
  id: "acme.bcrypt-hasher",
  apiVersion: 1,
  provides: [Capabilities.hasher],           // exclusive: replaces the core argon2id default
  make: () => ({ layer: BcryptHasherLive })
})
```

The core `Capabilities` registry (typed constants + JSON catalog consumed by compiler, CLI and docs):

```ts
export const Capabilities = {
  hasher:      Capability.exclusive("auth.hasher",       PasswordHasher),
  mailer:      Capability.exclusive("auth.mailer",       Mailer),
  sms:         Capability.exclusive("auth.sms",          SmsSender),
  rateLimiter: Capability.exclusive("auth.rate-limiter", RateLimiter),
  kv:          Capability.exclusive("auth.kv",           KeyValueStore),   // Redis-shaped seam for sessions/counters
  authorizer:  Capability.exclusive("auth.authorizer",   Authorizer),
  botDefense:  Capability.exclusive("auth.bot-defense",  BotDefense),
  webauthn:    Capability.exclusive("auth.webauthn",     WebAuthn)
} as const
// Namespaces "auth.*" and "effect-auth.*" are reserved; third parties use "<scope>.*".
// Multi-provider things (strategies, oauth providers, hooks, events) are contribution lists, not capabilities.
```

### 3.6 An external authorizer: OpenFGA

The `Authorizer` is a capability, so a Zanzibar engine is a Layer swap, not a rewrite. Only `filter` may be expensive or partial.

```ts
export const openfga = definePlugin({
  id: "openfga",
  apiVersion: 1,
  provides: [Capabilities.authorizer],
  options: Schema.Struct({ storeId: Schema.String, modelId: Schema.optional(Schema.String) }),

  make: (opts) => ({
    layer: Layer.effect(Authorizer, Effect.gen(function* () {
      const apiUrl = yield* Config.string("OPENFGA_URL")
      const client = /* HttpClient-based FGA client */
      return Authorizer.of({
        check:  (p, perm, r, consistency) => /* client.check(tuple(p, perm, r)) */,
        require: (p, perm, r) => /* check → Forbidden | ResourceNotFound + AuthzDenied event */,
        filter: (p, perm, kind) => /* client.listObjects → Stream */,
        authorizedActions: (p, r) => /* batch check over registry */,
        subjectOf: (principal) => principal.ref             // "<type>:<id>" round-trips to FGA
      })
    }))
  })
})
```

### 3.7 Wrapping a core flow: two-factor

Two-factor does not override `POST /password/sign-in`. It taps the core `beforeSessionIssue` point and *diverts* the flow, which is a typed outcome the compiler knows about. Route override stays reserved for official plugins and warns in `doctor`.

```ts
Hooks.beforeSessionIssue.tap(({ user, method }) => Effect.gen(function* () {
  const tf = yield* TwoFactorStore
  if (!(yield* tf.isEnabled(user.id))) return Hooks.continue
  const challenge = yield* tf.issueChallenge(user.id)      // short-TTL verification row
  return Hooks.divert(new TwoFactorRequired({ challengeId: challenge.id }))   // 202 + declared error schema
}), { order: "pre" })
```

---

## 4. Core types

### 4.1 Principal

```ts
export const PrincipalRef = Schema.Struct({ type: Schema.String, id: Schema.String })   // Zanzibar subject "<type>:<id>"

export type Principal =
  | { readonly _tag: "user";      readonly ref: PrincipalRef; readonly userId: UserId; readonly act?: PrincipalRef }
  | { readonly _tag: "apiKey";    readonly ref: PrincipalRef; readonly keyId: string; readonly scopes: ReadonlyArray<PermissionName> }
  | { readonly _tag: "service";   readonly ref: PrincipalRef; readonly scopes: ReadonlyArray<PermissionName> }
  | { readonly _tag: "anonymous"; readonly ref: PrincipalRef }

export interface AuthenticatedPrincipal {
  readonly principal: Principal
  readonly sessionId?: SessionId          // absent for session-less principals (api key, service)
  readonly strategy: string               // which strategy resolved it
}
```

`act` carries the impersonator (RFC 8693 shape). Authorization only ever sees `PrincipalRef`.

### 4.2 Session

```ts
export interface Session {
  readonly id: SessionId
  readonly userId: UserId
  readonly createdAt: DateTime.Utc
  readonly lastActiveAt: DateTime.Utc
  readonly absoluteExpiresAt: DateTime.Utc
  readonly idleExpiresAt: DateTime.Utc
  readonly ipAddress?: string
  readonly userAgent?: string
  readonly impersonatedBy?: PrincipalRef
}
// Token on the wire: `${id}.${secret}`; only SHA-256(secret) is stored, unique-indexed.
```

### 4.3 Errors

One helper, per-domain classes, status declared once on the error.

```ts
export class InvalidCredentials extends AuthError("InvalidCredentials", {
  status: 401,
  message: "Invalid email or password.",     // user-safe, uniform across enumeration-sensitive branches
  expose: "user"
})({}) {}

export class RateLimited extends AuthError("RateLimited", { status: 429 })({
  retryAfter: Schema.Number
}) {}
```

`AuthError` produces a `Schema.TaggedError` carrying `_tag`, `code` (stable, SCREAMING_CASE from the tag), `status`, `message`, and hides `cause`. Wire envelope: `{ code, status, message?, details? }`.

### 4.4 Hook points

```ts
export const Hooks = {
  // veto + amend
  beforeSignUp:        HookPoint.before("auth.user.signUp",       { input: SignUpInput }),
  beforeSignIn:        HookPoint.before("auth.signIn",            { input: SignInAttempt }),
  beforeSessionIssue:  HookPoint.before("auth.session.issue",     { input: SessionIssue, divert: true }),
  beforeAccountLink:   HookPoint.before("auth.account.link",      { input: LinkInput }),
  beforeUserDelete:    HookPoint.before("auth.user.delete",       { input: UserRef }),
  // observe only, fail-isolated
  afterSignUp:         HookPoint.after("auth.user.signUp",        { output: User }),
  afterSignIn:         HookPoint.after("auth.signIn",             { output: Session }),
  afterSessionRevoke:  HookPoint.after("auth.session.revoke",     { output: SessionRef })
} as const

// tap
Hooks.beforeSignIn.tap((ctx) => Effect<void | Amend<Input> | Divert, HookAbort>, { order?: number | "pre" | "post" })
```

Hook points are versioned with `apiVersion`. Hooks run for in-process calls and HTTP alike (better-auth got this right).

### 4.5 Events

```ts
export class UserSignedIn extends AuthEvent("auth.user.signedIn")({
  userId: Schema.String, sessionId: Schema.String, strategy: Schema.String
}) {}

// publish: never awaits observers
yield* events.publish(new UserSignedIn({ ... }))
// subscribe: forked into the runtime scope, catchCause-isolated, failures → log + auth.event.observer.error metric
AuthEvents.on(UserSignedIn, (e) => Audit.write(e))
```

Delivery is at-most-once in-process over a bounded `PubSub`; the append-only `auth_audit` table is the record of record. Durable outbox is a later plugin over `SqlPersistedQueue`.

---

## 5. The compiler

### 5.1 Phases

```
Auth.compile
  1  normalize          plugin instances → PluginRecord[]; options decoded via Schema
  2  identity           E_PLUGIN_DUPLICATE_ID · E_NAMESPACE_RESERVED · E_API_VERSION_UNSUPPORTED
  3  graph              requires.plugins → Kahn topo sort; E_PLUGIN_MISSING_DEP · E_PLUGIN_CYCLE (full path)
  4  capabilities       provides/requires/conflicts; E_CAPABILITY_MISSING · E_CAPABILITY_CONFLICT
  5  routes             normalized "METHOD path" keys, prefix injection; E_ROUTE_CONFLICT (exact + param-name)
  6  schema             prefix tables, validate extends, name every constraint; E_SCHEMA_CONFLICT
  7  hooks              resolve tap order; E_HOOK_VETO_INVALID (abort from an after point)
  8  middleware/strategies  phase + order resolution; E_MIDDLEWARE_READS_UNDECLARED
  9  aggregate          HttpApi · SchemaIR · migration plan · hook chain · strategy chain · event catalog
 10  emit               CompiledAuth + AuthManifest (hash-stamped, byte-deterministic)
```

### 5.2 Output

```ts
export interface CompiledAuth {
  readonly manifest: AuthManifest       // plugins (topo order), routes, capabilities, hook chains, strategy chain
  readonly api: HttpApi.Any
  readonly schema: SchemaIR             // JSON-serializable; snapshot-diffed by the migrator
  readonly migrations: ReadonlyArray<MigrationUnit>
  readonly hash: string                 // same plugin set → same hash
  readonly layer: Layer.Layer<AuthRuntime, never, AuthStore>
}
```

### 5.3 Diagnostics

Every diagnostic has a stable code, a one-line summary, the offending plugins, the installation site, a hint and a docs URL.

```
error E_PLUGIN_CYCLE  Plugin dependency cycle
  organization@1.0.0 → acme.invite@1.0.0 → organization@1.0.0
  introduced by organization() at src/auth.ts:14
  hint: extract the shared requirement into a capability and depend on requires.capabilities
  docs: https://effect-auth.dev/errors/E_PLUGIN_CYCLE

error E_CAPABILITY_CONFLICT  Two plugins provide the exclusive capability auth.hasher
  acme.bcrypt-hasher@1.0.0 (src/auth.ts:9)
  argon2-native@1.2.0      (src/auth.ts:10)
  hint: remove one, or provide the hasher with Layer.provide outside Auth.define

error E_ROUTE_CONFLICT  POST /auth/invite/:id vs POST /auth/invite/:token
  same tree position, different parameter names
  acme.invite@1.0.0 → endpoint "accept"
  acme.legacy-invite@0.3.0 → endpoint "redeem"
```

`PluginCompileError` is a `Schema.TaggedError` union so tests can assert on codes.

---

## 6. Schema and migrations

### 6.1 Defining tables

`Table.make` builds the Schema IR and the derived Effect Schemas at once, so one definition drives validation, repositories and DDL.

```ts
export const Passkey = Table.make("credential", {            // physical: passkey_credential
  id:           Column.id(),                                  // uuid v7, primary key
  userId:       Column.ref(Users.Table, { onDelete: "cascade" }),
  credentialId: Column.bytes({ unique: true }),
  publicKey:    Column.bytes(),
  counter:      Column.bigint({ default: 0 }),
  transports:   Column.json(Schema.Array(Schema.String)),
  backedUp:     Column.boolean({ default: false }),
  createdAt:    Column.createdAt(),
  lastUsedAt:   Column.timestamp({ nullable: true })
}, { indexes: [Index.on("userId")] })

Passkey.Row     // Schema.Struct of the decoded row
Passkey.Insert  // Schema.Struct with defaults optional
Passkey.ir      // TableIR (plain JSON)
```

Constraint names are generated by a fixed grammar (`{table}_{cols}_idx|uq|fk|ck`), so no dialect ever invents one.

### 6.2 Extending shared tables

Allowed only for scalar, nullable-or-defaulted, non-unique, non-indexed columns; anything else is a side table.

```ts
schema: {
  extends: {
    user: { twoFactorEnabled: Column.boolean({ default: false }) }   // ok
    // user: { totpSecret: Column.string(64) }                        // E_SCHEMA_CONFLICT: sensitive on shared table
  }
}
```

Two plugins claiming the same column with identical IR resolve by topo order; different IR is an error.

### 6.3 Repositories

```ts
const store = yield* AuthStore
const passkeys = store.table(Passkey)
yield* passkeys.insert({ userId, credentialId, publicKey })
yield* passkeys.findOne({ credentialId })
yield* passkeys.list({ where: { userId }, after: cursor, limit: 50 })   // keyset only, no offsets
yield* store.transaction(Effect.gen(function* () { /* nested = savepoint */ }))
```

`AuthStore` is a narrow table-driven interface so `MemoryStore`, `SqlStore` and edge stores implement the same thing. Plugins needing raw SQL declare `requires.capabilities: [Capabilities.sql]` and get `SqlClient`.

### 6.4 Migrations

```
effect-auth migration generate            snapshot diff (never the live DB) → 0004_invite/{migration.sql, snapshot.json, plan.json}
effect-auth migration apply               dry-run by default; --yes in CI; destructive ops need --allow-destructive "<reason>"
effect-auth migration status [--drift]    files vs auth_migrations ledger; --drift introspects the DB, non-zero exit
```

Statements are ordered core → plugin topo order, annotated `-- plugin: acme.invite`, hash-stamped. Plugin-authored steps (`MigrationUnit.effect`) run after the generated section of their own unit.

---

## 7. Client

### 7.1 Isomorphic contract

Plugin packages export their API group from `./api` with no server code. Apps that need a separate client bundle declare the contract once:

```ts
// auth.contract.ts — safe for the browser
import { AuthContract } from "@effect-auth/core/contract"
import { PasswordApi } from "@effect-auth/password/api"
import { PasskeyApi } from "@effect-auth/passkey/api"
import { OrganizationApi } from "@effect-auth/organization/api"

export const contract = AuthContract.make({ basePath: "/auth", groups: [PasswordApi, PasskeyApi, OrganizationApi] })

// auth.server.ts
export const auth = Auth.define({ contract, plugins: [password(), passkey(), organization()] })
// compile error if a plugin's api is missing from the contract or vice versa (shallow union check)
```

Same-repo servers may skip the contract and use `auth.api` directly.

### 7.2 Vanilla client

```ts
import { AuthClient } from "@effect-auth/client"

export const authClient = AuthClient.make(contract, {
  baseUrl: "https://app.example.com",
  mode: "cookie"                                   // default; "bearer" for native clients
})

// every method is HttpApiClient-derived: encoded payloads, decoded successes, typed error unions
const session = yield* authClient.api.password.signIn({ payload: { email, password } })
//   Effect<Session, InvalidCredentials | RateLimited | HttpClientError | ParseError>

yield* authClient.session.get()                    // Option<Session>
yield* authClient.session.hydrate(initialSession)   // SSR: first non-null wins
authClient.$ERROR_CODES                             // "INVALID_CREDENTIALS" | "RATE_LIMITED" | ...  (derived from the contract)
```

CSRF is handled by the client's `transformClient`: it reads the readable `__Host-csrf` cookie and sets `x-csrf-token` on unsafe methods. There is no client-plugin concept; a plugin's client API *is* its HttpApiGroup.

### 7.3 React

```tsx
import { AuthClientProvider, useSession, useAuthAction } from "@effect-auth/react"

<AuthClientProvider client={authClient}>...</AuthClientProvider>

function Profile() {
  const { data, isPending, error, refetch } = useSession()
  const signOut = useAuthAction((c) => c.api.core.signOut)
  ...
}
```

`@effect-auth/react-query` exports `sessionQueryOptions(client)` and `apiQueryOptions(client, "password", "signIn")` for TanStack shops.

### 7.4 Framework adapters

Five functions, nothing else: `authHandler`, `getSession(input, { strategy: "cookie-presence" | "cookie-cache" | "database" })`, `cookieBridge` (where the framework owns the jar), `principalMiddleware`, and a client re-export.

```ts
// app/api/auth/[...all]/route.ts
import { toNextRouteHandler } from "@effect-auth/next"
export const { GET, POST } = toNextRouteHandler(auth, AuthLive)

// data access layer
const session = await getSession({ headers: await headers() }, { strategy: "database" })
```

---

## 8. Testing

### 8.1 App tests

```ts
import { TestAuth } from "@effect-auth/test"
import { it } from "@effect/vitest"

const TestLive = TestAuth.layer(auth)   // MemoryStore + TestClock + recording Mailer + permissive RateLimiter

it.effect("session expires after the idle window", () =>
  Effect.gen(function* () {
    const client = yield* TestAuth.client(auth)     // HttpApi → web handler → HttpApiClient; no socket
    yield* client.api.password.signUp({ payload: { email: "a@b.c", password: "correct horse battery staple" } })
    yield* TestClock.adjust(Duration.days(8))
    const err = yield* Effect.flip(client.api.core.session())
    expect(err._tag).toBe("SessionExpired")
  }).pipe(Effect.provide(TestLive))
)
```

### 8.2 Plugin contract tests

```ts
import { runPluginContractTests } from "@effect-auth/test"
import { invite } from "../src/index.js"

runPluginContractTests(invite, {
  options: [{}, { ttl: Duration.hours(1) }],       // asserts manifest hash is options-independent
  host: { plugins: [password()] }                  // the dependency scenario
})
// Generated cases:
//   metadata: id namespace, apiVersion, reserved capabilities
//   routes:   uniqueness, normalized keys, param-name collisions
//   schema:   prefixes, reserved columns, NOT NULL without default, sensitive fields on shared tables
//   migrations: two compiles → identical hash; destructive ops flagged
//   hooks:    veto only in before*; a throwing after-tap does not fail sign-in
//   redaction: no Redacted value stringifies in spans or events
//   deps:     host without `password` → exactly E_PLUGIN_MISSING_DEP
```

---

## 9. CLI

The CLI loads `auth.config.ts`, runs `Auth.compile`, and never touches a database unless the command says so.

```
effect-auth doctor                 compile + config + insecure defaults + missing migrations
effect-auth plugin list [--graph]  resolved topo order, capabilities, hook chains
effect-auth routes                 normalized route table with owning plugin
effect-auth schema                 IR with per-column owner
effect-auth openapi > openapi.json aggregated spec, security schemes
effect-auth migration generate | apply | status
effect-auth seed admin             claim-URL bootstrap, never a seeded password
effect-auth import --from better-auth --dry-run
```

---

## 10. End-to-end example

```ts
// src/auth.ts
export const auth = Auth.define({
  basePath: "/auth",
  plugins: [
    password({ minLength: 12 }),
    oauth({ providers: [google()] }),
    passkey({ rpId: "example.com", origins: ["https://example.com"] }),
    organization(),
    companyEmail()                         // the 12-line hook plugin from §3.2
  ]
})

export const AuthLive = auth.layer.pipe(
  Layer.provide(SqlStore.layer),
  Layer.provide(PgClient.layer({ url: Config.redacted("DATABASE_URL") })),
  Layer.provide(SesMailer.layer)           // satisfies auth.mailer
)

// src/api.ts
const AppApi = HttpApi.make("app").add(
  HttpApiGroup.make("projects")
    .add(HttpApiEndpoint.get("list", "/projects").addSuccess(Schema.Array(Project)))
    .add(HttpApiEndpoint.del("delete", "/projects/:id").setPath(Schema.Struct({ id: ProjectId })))
    .middleware(Authenticated)
)

const ProjectsLive = HttpApiBuilder.group(AppApi, "projects", (h) =>
  h.handle("list", () => Effect.gen(function* () {
      const principal = yield* CurrentPrincipal
      const ids = yield* Authorizer.filter(principal.ref, perms.project.read, "project")
      return yield* Projects.byIds(ids)
    }))
   .handle("delete", ({ path }) => Effect.gen(function* () {
      const project = yield* Projects.byId(path.id)
      yield* Authorizer.require(perms.project.delete, project)
      yield* Projects.remove(path.id)
    }))
)

// src/server.ts
const Server = HttpApiBuilder.serve().pipe(
  Layer.provide(HttpApiBuilder.api(AppApi).pipe(Layer.provide(ProjectsLive))),
  Layer.provide(AuthHttp.layer(auth)),
  Layer.provide(AuthLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)
NodeRuntime.runMain(Layer.launch(Server))
```

Startup either succeeds with a printed manifest, or fails with a coded diagnostic before a port is opened.

---

## 11. Decisions this proposal makes

Taken (with the research that backs them):

| Decision | Choice | Source |
|---|---|---|
| Plugin contract | frozen record, static + `make(options)` halves, `id` + `apiVersion` required | 09 Q20, 14, 18 law 1 |
| Dependencies | `requires.plugins` (structure) + `requires.capabilities` (authority); tags stay service-level | 09 Q21, 02 Q21 |
| Type strategy | `Auth.define` generic only over the tuple; derived types are indexed accesses | 01 Q8, 09 Q22 |
| Facade | plugin services + derived HttpApi; no synthesized type-level facade | 01 Q14, 11 Q39 |
| Routes | compiler-injected `/<id>` prefix for every plugin; core owns root; override reserved | 09 Q24 |
| Schema | side tables auto-prefixed; `extends.user` scalar-only with rules | 09 Q25, 10 Q78 |
| Hooks | typed points; `before*` veto/amend/divert; `after*` fail-isolated; topo → order → id | 09 Q27, 01 Q12 |
| Strategies | ordered chain, first match wins, presented-but-invalid is an error | 04 Q61 |
| Client | HttpApiClient over an isomorphic contract; no client plugins | 11 Q39, 02 Q29 |
| Authorization | `Authorizer` capability; typed registry; plain-Effect policies; deny by default | 08 |
| Store | narrow table-driven `AuthStore`; raw SQL behind a capability | 10 Q72/Q80, 02 default 14 |
| Config | structural config Schema-validated at compile; secrets only via `Config.redacted` in layers | 01 Q15 |
| Tenants | `LayerMap` seam in v1, config validated against the manifest | 09 Q30, 01 |

Still open (product calls, not derivable from research):

1. npm scope rename (`@effect-auth` is taken).
2. Effect track: `^3.22` + v4-rc CI (recommended) vs waiting for v4 stable.
3. Whether third-party plugins may ever `override` a core route (proposal: no).
4. Session lifetime defaults: 30d/7d (PRD) vs 7d/1d (ecosystem).
5. React primitive priority: `@effect-atom` first (proposal) vs TanStack-first.
6. Registry policy: curated + contract-test badge (proposal) vs open list.

---

## 12. Research trace

| Section | Backed by |
|---|---|
| §0 laws | research 18 §7; 13; 15 |
| §2 app surface | 01 Q8/Q11/Q14/Q15; PRD §40, §55, §63 |
| §2.6 authorization | 08 Q64–Q71 |
| §2.8 tenants | 09 Q30; 01 (LayerMap since 3.14) |
| §3 plugin contract | 09 Q20–Q28; 02 Q20–Q31; better-auth/03-plugin-system/01 (what to keep: hooks run in-process too, `input`/`returned` field flags; what to drop: `init` context mutation, last-wins merges, `adapter` override) |
| §4.1 principal | 08 Q44 |
| §4.2 sessions | 04 Q45–Q47 |
| §4.3 errors | 01 Q17; 11 Q86 |
| §4.5 events | 01 Q13 |
| §5 compiler | PRD §12; 09 Q22 diagnostics taxonomy; 16 (apiVersion policy) |
| §6 schema | 10 Q73–Q78 |
| §7 client | 11 Q39/Q82–Q85 |
| §8 testing | 01 Q18; 09 Q31 |
| §9 CLI | PRD §37; 10 Q75/Q81 |
