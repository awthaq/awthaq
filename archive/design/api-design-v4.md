> **Partially superseded.** §8 (`Auth.link`: the linker) is superseded by `design/plugins-as-layers.md` v0.3's `Auth.make`/`Validate<P>` composition model, now normatively specified in `spec/behaviors/02-plugin-composition-validate.md`. §§1–7 and §9+ are otherwise still representative of the seven-strata design.

# Awthaq — Layered, API-first Design on Effect v4

Version 0.2 — 2026-09-12. Supersedes the runtime model of v0.1 (`design/api-design.md`); the research trace and the product decisions there still hold. Every API below was checked against the Effect v4 source in `../effect` (rc line, `packages/effect/src`) and the qadi source in `../qadi` (0.4.0). Authorization is delegated to qadi; awthaq resolves *who is asking*, qadi decides *what they may do*.

---

## 0. What changed from v0.1, and why

v0.1 invented a plugin record, a compiler, and private registries for hooks, strategies, events and storage. Effect v4 already ships most of that substrate, and using it makes the design both smaller and more layered:

| v0.1 invented | v4 provides | Consequence |
|---|---|---|
| a plugin record with `api`, `schema`, `hooks`, `strategies` fields | `HttpApi.addHttpApi`, `HttpApiBuilder.group` returning a `Layer` per group, group keys derived from the group id only | a plugin is a contract plus a Layer plus a small manifest |
| a strategy chain runtime | `HttpApiMiddleware.Service` with several `security` schemes, tried in declaration order, first success wins | the chain is the middleware's security record |
| `AuthStore` table interface | `Model.Class` variants, `SqlModel.makeRepository`, `Migrator.fromRecord` | persistence is ordinary v4 SQL code |
| `RateLimiter`, `KeyValueStore`, `Crypto` capabilities | `effect/unstable/persistence` and `effect/Crypto` | ports are Effect services we consume, not define |
| an `Authorizer` capability, permission registry, policy combinators | `@qadi/core`, `@qadi/http`, `@qadi/react` | authorization leaves the library entirely |
| a synthesized client facade | `HttpApiClient.make`, `AtomHttpApi.Service`, `HttpApiMiddleware.layerClient` with `requiredForClient` | the client cannot compile without the CSRF layer |
| config as plain objects | `Context.Reference` defaults, `Config.Redacted`, `Layer.unwrap` | defaults are services with default values |
| tenant seam | `LayerMap.Service`, `LayerRef.Service` | keyed provider configs and rotatable key rings |

The compiler survives as a **linker**: it validates manifests, orders migrations and merges contracts. It never looks inside a Layer.

---

## 1. The strata

Every package sits in exactly one stratum. Dependencies point downward only. Each stratum boundary is a `Layer` boundary, and every service follows the v4 convention `layerNoDeps` (requires its stratum's ports) / `layer` (fully provided) / `layerMemory` (tests).

```
7  Composition     Auth.api · Auth.link · Auth.layer                      the app owns the wiring
6  Authorization   @qadi/core · @qadi/http · @qadi/react                  decisions, projections, gates
5  HTTP            HttpApiBuilder groups · middleware implementations · HttpRouter
4  Domain          Users · Sessions · Accounts · Verification · Authentication · AuthHooks · AuthEvents
3  Persistence     Model.Class · SqlModel repositories · Migrator records
2  Ports           Crypto · KeyValueStore · RateLimiter · SqlClient · PasswordHasher · Mailer · WebAuthn
1  Contract        Schemas · errors · HttpApiGroup · HttpApi · middleware definitions   (isomorphic)
```

API-first means stratum 1 is written first and alone: it has no server code, it is what the client, the OpenAPI document, the tests and the handlers all derive from.

### Package map

| Stratum | Package | Contents |
|---|---|---|
| 1 | `@awthaq/api` | `Principal`, `SessionView`, `SubjectDto`, errors, `Authentication`/`CsrfProtection` middleware definitions, `CoreApi` |
| 1 | `@awthaq/<plugin>/api` | each plugin's `HttpApiGroup` + contract `HttpApi`, schemas, errors |
| 2 | `@awthaq/ports` | `PasswordHasher`, `Mailer`, `WebAuthn` services with `layer`, `layerNoop`, `layerMemory` |
| 3 | `@awthaq/sql` | `Model.Class` models, repositories, migration records, `layerMemory` twins |
| 4 | `@awthaq/core` | domain services, `AuthHooks`, `AuthEvents`, `SessionConfig`, `SubjectResolver` |
| 5 | `@awthaq/server` | middleware implementations, core handlers, `AuthHttp` |
| 6 | `@awthaq/qadi` | `AuthorizedSubject` middleware, `SubjectExtractor` layer, `SubjectDto` codecs |
| 7 | `@awthaq/core` (`Auth` namespace) | `Auth.plugin`, `Auth.api`, `Auth.link`, `Auth.layer` |
| client | `@awthaq/client`, `@awthaq/react` | `AuthClient` (AtomHttpApi), `useSession`, `AuthClientProvider` |
| tools | `@awthaq/test`, `@awthaq/cli` | `TestAuth`, contract tests, `doctor`, migrations |

---

## 2. Stratum 1 — Contract

### 2.1 Identity schemas

```ts
// @awthaq/api/src/Principal.ts
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

// Zanzibar-shaped subject reference: "<type>:<id>". The only field authorization sees.
export const PrincipalRef = Schema.Struct({ type: Schema.String, id: Schema.String })

export class UserPrincipal extends Schema.TaggedClass<UserPrincipal>()("User", {
  ref: PrincipalRef,
  userId: UserId,
  sessionId: SessionId,
  actingAs: Schema.optional(PrincipalRef)          // impersonation: RFC 8693 `act`
}) {}

export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
  ref: PrincipalRef,
  keyId: Schema.String,
  scopes: Schema.Array(Schema.String)
}) {}

export class ServicePrincipal extends Schema.TaggedClass<ServicePrincipal>()("Service", {
  ref: PrincipalRef,
  scopes: Schema.Array(Schema.String)
}) {}

export const Principal = Schema.Union([UserPrincipal, ApiKeyPrincipal, ServicePrincipal])
export type Principal = typeof Principal.Type
```

### 2.2 Errors

Status lives on the error class. Wire shape is the tagged struct; internal causes never reach it.

```ts
// @awthaq/api/src/Errors.ts
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  reason: Schema.Literals(["missing", "invalid", "expired", "revoked"])
}, { httpApiStatus: 401 }) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials", {}, { httpApiStatus: 401 }              // uniform on purpose: no enumeration
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterMillis: Schema.Int
}, { httpApiStatus: 429 }) {}

export class CsrfRejected extends Schema.TaggedError<CsrfRejected>()("CsrfRejected", {}, { httpApiStatus: 403 }) {}

export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()("TwoFactorRequired", {
  challengeId: Schema.String
}, { httpApiStatus: 202 }) {}
```

### 2.3 The security record is the strategy chain

```ts
// @awthaq/api/src/Authentication.ts
import { Context } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "awthaq/CurrentPrincipal"
) {}

export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" })

// One middleware, several schemes. v4 tries them in declaration order and returns the
// first success; if none succeeds, the last scheme's failure is the response.
// Adding a strategy = adding a key here and a handler in the implementation (§5.1).
export class Authentication extends HttpApiMiddleware.Service<Authentication, {
  provides: CurrentPrincipal
}>()("awthaq/Authentication", {
  security: {
    cookie: SessionCookie,               // 1. browser session
    bearer: HttpApiSecurity.bearer       // 2. session token or JWT in Authorization
  },
  error: Unauthenticated
}) {}

// Same, but a missing credential yields an anonymous principal instead of 401.
export class OptionalAuthentication extends HttpApiMiddleware.Service<OptionalAuthentication, {
  provides: CurrentPrincipal
}>()("awthaq/OptionalAuthentication", {
  security: { cookie: SessionCookie, bearer: HttpApiSecurity.bearer }
}) {}

// CSRF is a client obligation as much as a server check: `requiredForClient` means a
// generated client does not type-check until it provides the client half (§9).
export class CsrfProtection extends HttpApiMiddleware.Service<CsrfProtection, {
  clientError: CsrfRejected
}>()("awthaq/CsrfProtection", {
  error: CsrfRejected,
  requiredForClient: true
}) {}
```

### 2.4 Views

```ts
// @awthaq/api/src/Views.ts
export const SessionSummary = Schema.Struct({
  id: SessionId,
  createdAt: Schema.DateTimeUtcFromString,
  lastActiveAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  userAgent: Schema.optional(Schema.String),
  current: Schema.Boolean
})

// The serialized qadi subject. Sets become arrays on the wire; @awthaq/qadi
// turns it back into an AuthSubject with makeSubject (§7.1).
export const SubjectDto = Schema.Struct({
  id: Schema.String,
  roles: Schema.Array(Schema.String),
  permissions: Schema.Array(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Unknown)
})

export const SessionView = Schema.Struct({
  principal: Principal,
  user: UserView,             // the User model's json variant (§4.1)
  session: SessionSummary,
  subject: SubjectDto
})
```

### 2.5 Core groups and the core contract

```ts
// @awthaq/api/src/CoreApi.ts
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export class SessionApi extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("current", "/", { success: SessionView }),
    HttpApiEndpoint.get("list", "/all", { success: Schema.Array(SessionSummary) }),
    HttpApiEndpoint.post("signOut", "/sign-out", { success: HttpApiSchema.NoContent }),
    HttpApiEndpoint.post("revoke", "/:id/revoke", {
      params: { id: SessionId },
      success: HttpApiSchema.NoContent,
      error: SessionNotFound
    }),
    HttpApiEndpoint.post("revokeOthers", "/revoke-others", { success: HttpApiSchema.NoContent })
  )
  .middleware(Authentication)
  .middleware(CsrfProtection)
  .prefix("/session")
  .annotateMerge(OpenApi.annotations({ title: "Session" }))
{}

export class CoreApi extends HttpApi.make("auth").add(SessionApi) {}
```

### 2.6 A plugin contract: password

```ts
// @awthaq/password/src/api.ts   (subpath export "@awthaq/password/api", no server code)
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { CsrfProtection, InvalidCredentials, RateLimited, SessionView, TwoFactorRequired } from "@awthaq/api"

export const Email = Schema.String.pipe(Schema.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)))
// Decoded into Redacted<string>: application code never holds a plain password.
export const Password = Schema.RedactedFromValue(Schema.String.pipe(Schema.check(Schema.isMinLength(12))))

export class EmailTaken extends Schema.TaggedError<EmailTaken>()("EmailTaken", {}, { httpApiStatus: 409 }) {}
export class WeakPassword extends Schema.TaggedError<WeakPassword>()("WeakPassword", {
  hints: Schema.Array(Schema.String)
}, { httpApiStatus: 422 }) {}

export class PasswordApi extends HttpApiGroup.make("password")
  .add(
    HttpApiEndpoint.post("signUp", "/sign-up", {
      payload: { email: Email, password: Password, name: Schema.optional(Schema.String) },
      success: SessionView,
      error: [EmailTaken, WeakPassword, RateLimited]
    }),
    HttpApiEndpoint.post("signIn", "/sign-in", {
      payload: { email: Email, password: Password },
      success: SessionView,
      error: [InvalidCredentials, RateLimited, TwoFactorRequired]
    }),
    HttpApiEndpoint.post("requestReset", "/reset", {
      payload: { email: Email },
      success: HttpApiSchema.Accepted                     // always 202: no enumeration
    }),
    HttpApiEndpoint.post("confirmReset", "/reset/confirm", {
      payload: { token: Schema.RedactedFromValue(Schema.String), password: Password },
      success: HttpApiSchema.NoContent,
      error: [InvalidToken, WeakPassword]
    })
  )
  .middleware(CsrfProtection)
  .prefix("/password")
{}

// The plugin's own HttpApi. Handlers are built against this and still satisfy the
// app's merged AuthApi, because a group's service key is derived from the group id.
export class PasswordContract extends HttpApi.make("auth").add(PasswordApi) {}
```

### 2.7 The app's merged contract

```ts
// app/auth.contract.ts — isomorphic, imported by server, client and tests
import { HttpApi } from "effect/unstable/httpapi"
import { CoreApi } from "@awthaq/api"
import { PasswordContract } from "@awthaq/password/api"
import { PasskeyContract } from "@awthaq/passkey/api"
import { OrganizationContract } from "@awthaq/organization/api"

export class AuthApi extends HttpApi.make("auth")
  .addHttpApi(CoreApi)
  .addHttpApi(PasswordContract)
  .addHttpApi(PasskeyContract)
  .addHttpApi(OrganizationContract)
  .prefix("/auth")
{}
```

`Auth.api([...contracts])` (§8.2) is sugar for exactly this chain, plus a duplicate-group check that names both plugins.

---

## 3. Stratum 2 — Ports

Ports are `Context.Service`s. Where v4 already defines one, we consume it unchanged.

| Port | Owner | Default layer | Used for |
|---|---|---|---|
| `Crypto` | `effect/Crypto` | platform layer (`NodeServices`) | random bytes, SHA-256, UUID v7 |
| `KeyValueStore` | `effect/unstable/persistence` | `layerMemory`, `layerSql`, Redis | cookie-cache, challenges, counters |
| `RateLimiter` | `effect/unstable/persistence` | `layer` + `layerStoreMemory` / `layerStoreRedis` | per-route limits |
| `SqlClient` | `effect/unstable/sql` | `@effect/sql-pg`, `@effect/sql-sqlite-node` | persistence |
| `PasswordHasher` | `@awthaq/ports` | `layerArgon2id`, `layerScrypt` (edge) | password plugin |
| `Mailer` | `@awthaq/ports` | `layerNoop` (fails loudly in prod), `layerMemory` (records) | verification, reset, invites |
| `WebAuthn` | `@awthaq/ports` | `layerSimpleWebAuthn` | passkey plugin |

```ts
// @awthaq/ports/src/PasswordHasher.ts
export class PasswordHasher extends Context.Service<PasswordHasher, {
  hash(plain: Redacted.Redacted<string>): Effect.Effect<string>            // PHC string
  verify(plain: Redacted.Redacted<string>, phc: string): Effect.Effect<boolean>   // constant-time
  needsRehash(phc: string): boolean
}>()("awthaq/ports/PasswordHasher") {
  static readonly layerArgon2id = Layer.effect(PasswordHasher, Effect.gen(function*() {
    const cost = yield* Config.Int("AUTH_ARGON2_MEMORY_KIB").pipe(Config.withDefault(19_456))
    /* @node-rs/argon2 */
    return PasswordHasher.of({ /* ... */ })
  }))
  static readonly layerScrypt: Layer.Layer<PasswordHasher> = /* WebCrypto-only runtimes */ null!
}
```

Swapping a port is a `Layer.provide` at composition time (§8.4). Two providers of one service cannot both win: the later `Layer.provide` shadows, so the linker refuses a plugin that *declares* a port another plugin declares (`E_PORT_CONFLICT`).

---

## 4. Stratum 3 — Persistence

### 4.1 Models

`Model.Class` is the one definition per entity. The `json` variants feed stratum 1; `insert`/`update` feed repositories. Sensitive columns exist only in database variants.

```ts
// @awthaq/sql/src/models/Session.ts
import { Model } from "effect/unstable/schema"

export class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert(UserId),
  email: Schema.String,
  emailVerifiedAt: Model.FieldOption(Schema.DateTimeUtcFromString),
  name: Model.FieldOption(Schema.String),
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate
}) {}
export const UserView = User.json

export class Session extends Model.Class<Session>("Session")({
  id: Model.UuidV7Insert(SessionId),
  userId: UserId,
  secretHash: Model.Sensitive(Schema.String),              // SHA-256 of the secret, never in JSON
  createdAt: Model.DateTimeInsert,
  lastActiveAt: Model.DateTimeUpdate,
  absoluteExpiresAt: Schema.DateTimeUtcFromString,
  idleExpiresAt: Schema.DateTimeUtcFromString,
  ipAddress: Model.FieldOption(Schema.String),
  userAgent: Model.FieldOption(Schema.String),
  actingAs: Model.FieldOption(Schema.String)
}) {}

export class Account extends Model.Class<Account>("Account")({
  id: Model.UuidV7Insert(AccountId),
  userId: UserId,
  provider: Schema.String,                                 // "password" | "oauth:google" | "passkey"
  subject: Schema.String,                                  // provider-scoped stable id
  secret: Model.Sensitive(Model.FieldOption(Schema.String)),   // PHC hash, encrypted refresh token…
  createdAt: Model.DateTimeInsert
}) {}

export class VerificationToken extends Model.Class<VerificationToken>("VerificationToken")({
  id: Model.UuidV7Insert(TokenId),
  purpose: Schema.Literals(["email_verify", "password_reset", "invite", "email_otp", "two_factor"]),
  tokenHash: Model.Sensitive(Schema.String),
  userId: Model.FieldOption(UserId),
  expiresAt: Schema.DateTimeUtcFromString,
  consumedAt: Model.FieldOption(Schema.DateTimeUtcFromString),
  createdAt: Model.DateTimeInsert
}) {}
```

### 4.2 Repositories

```ts
// @awthaq/sql/src/SessionRepo.ts
export class SessionRepo extends Context.Service<SessionRepo, {
  insert(row: typeof Session.insert.Type): Effect.Effect<Session>
  findBySecretHash(hash: string): Effect.Effect<Option.Option<Session>>
  listByUser(userId: UserId): Effect.Effect<Array<Session>>
  touch(id: SessionId, idleExpiresAt: DateTime.Utc): Effect.Effect<void>
  remove(id: SessionId): Effect.Effect<void>
  removeOthers(userId: UserId, keep: SessionId): Effect.Effect<void>
}>()("awthaq/sql/SessionRepo") {
  static readonly layerNoDeps = Layer.effect(SessionRepo, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* SqlModel.makeRepository(Session, {
      tableName: "auth_session", spanPrefix: "SessionRepo", idColumn: "id"
    })
    const findBySecretHash = SqlSchema.findOne({
      Request: Schema.String, Result: Session,
      execute: (hash) => sql`SELECT * FROM auth_session WHERE secret_hash = ${hash}`
    })
    return SessionRepo.of({ insert: repo.insert, findBySecretHash, /* ... */ })
  }))

  static readonly layerMemory: Layer.Layer<SessionRepo> = /* Map-backed, same interface */ null!
}
```

### 4.3 Migrations

Migrations are the v4 `Migrator` record shape. A plugin exports its own record; the linker (§8.3) concatenates records in plugin topological order and re-keys them `NNNN_<plugin>_<name>` so ordering is deterministic and attributable.

```ts
// @awthaq/password/src/migrations.ts
export const migrations = {
  "0001_password_account_index": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE UNIQUE INDEX auth_account_provider_subject_uq ON auth_account (provider, subject)`
  })
} satisfies Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
```

The snapshot-diff planner with a checksum ledger from v0.1 stays a CLI feature on top of this record; v1 runs on the stock `Migrator` because it is what the ecosystem's driver packages implement.

---

## 5. Stratum 4 — Domain

### 5.1 Configuration as services with defaults

```ts
// @awthaq/core/src/SessionConfig.ts
export const SessionConfig = Context.Reference<{
  readonly absolute: Duration.Duration
  readonly idle: Duration.Duration
  readonly touchEvery: Duration.Duration
  readonly cookie: { readonly name: string; readonly sameSite: "strict" | "lax"; readonly secure: boolean }
}>("awthaq/SessionConfig", {
  defaultValue: () => ({
    absolute: Duration.days(30),
    idle: Duration.days(7),
    touchEvery: Duration.hours(1),
    cookie: { name: "__Host-session", sameSite: "strict", secure: true }
  })
})
// override: Layer.succeed(SessionConfig, { ...defaults, idle: Duration.days(1) })
```

Secrets are never in a `Reference`; they are read inside layers with `Config.Redacted("AUTH_SECRET")` and `Layer.unwrap`.

### 5.2 Sessions

```ts
// @awthaq/core/src/Sessions.ts
export class Sessions extends Context.Service<Sessions, {
  issue(input: { userId: UserId; request?: RequestInfo; actingAs?: PrincipalRef }): Effect.Effect<IssuedSession>
  resolve(token: Redacted.Redacted<string>): Effect.Effect<Session, Unauthenticated>
  revoke(id: SessionId): Effect.Effect<void, SessionNotFound>
  revokeOthers(userId: UserId, keep: SessionId): Effect.Effect<void>
  list(userId: UserId): Effect.Effect<Array<Session>>
}>()("awthaq/Sessions") {
  static readonly layerNoDeps = Layer.effect(Sessions, Effect.gen(function*() {
    const repo = yield* SessionRepo
    const crypto = yield* Crypto.Crypto
    const config = yield* SessionConfig
    const events = yield* AuthEvents

    // token = id.secret ; only SHA-256(secret) is stored
    const issue = Effect.fn("Sessions.issue")(function*(input) {
      const secret = yield* crypto.randomBytes(32)
      const hash = yield* crypto.digest("SHA-256", secret)
      const now = yield* DateTime.now
      const row = yield* Session.insert.makeEffect({
        userId: input.userId,
        secretHash: Encoding.encodeHex(hash),
        absoluteExpiresAt: DateTime.add(now, config.absolute),
        idleExpiresAt: DateTime.add(now, config.idle),
        ipAddress: input.request?.ip, userAgent: input.request?.userAgent, actingAs: input.actingAs?.id
      }).pipe(Effect.flatMap(repo.insert), Effect.orDie)
      yield* events.publish(new SessionIssued({ sessionId: row.id, userId: row.userId }))
      return { session: row, token: Redacted.make(`${row.id}.${Encoding.encodeBase64Url(secret)}`) }
    })

    const resolve = Effect.fn("Sessions.resolve")(function*(token) {
      const [id, secret] = Redacted.value(token).split(".")
      if (!id || !secret) return yield* new Unauthenticated({ reason: "invalid" })
      const hash = yield* crypto.digest("SHA-256", Encoding.decodeBase64UrlUnsafe(secret))
      const row = yield* repo.findBySecretHash(Encoding.encodeHex(hash))
      if (Option.isNone(row) || row.value.id !== id) return yield* new Unauthenticated({ reason: "invalid" })
      const now = yield* DateTime.now
      if (DateTime.isPast(row.value.absoluteExpiresAt) || DateTime.isPast(row.value.idleExpiresAt)) {
        return yield* new Unauthenticated({ reason: "expired" })
      }
      // sliding refresh, throttled: at most one write per touchEvery
      if (DateTime.distance(row.value.lastActiveAt, now) > Duration.toMillis(config.touchEvery)) {
        yield* repo.touch(row.value.id, DateTime.add(now, config.idle))
      }
      return row.value
    })

    return Sessions.of({ issue, resolve, /* ... */ })
  }))

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(SessionRepo.layerNoDeps))
}
```

### 5.3 Hooks are a registry, filled by Layers

This mirrors how v4 fills an `HttpRouter`: a service holds the registry, and contributors are `Layer.effectDiscard` values that register into it. A plugin's hook taps are therefore just part of the plugin's `layer`.

```ts
// @awthaq/core/src/AuthHooks.ts
export interface HookPoint<I, O> { readonly id: string; readonly input: Schema.Schema<I>; readonly output: Schema.Schema<O> }

export const Hooks = {
  beforeSignUp:       HookPoint.veto("auth.user.signUp", SignUpInput),          // may abort or amend
  beforeSignIn:       HookPoint.veto("auth.signIn", SignInAttempt),
  beforeSessionIssue: HookPoint.divert("auth.session.issue", SessionIssueInput, TwoFactorRequired),
  afterSignUp:        HookPoint.observe("auth.user.signUp", User),              // fail-isolated
  afterSignIn:        HookPoint.observe("auth.signIn", Session)
} as const

export class AuthHooks extends Context.Service<AuthHooks, {
  tap<I, O, E, R>(point: HookPoint<I, O>, handler: (input: I) => Effect.Effect<O, E, R>,
                  options?: { readonly order?: number | "pre" | "post"; readonly plugin?: string }): Effect.Effect<void, never, R>
  run<I, O>(point: HookPoint<I, O>, input: I): Effect.Effect<O, HookAbort>
}>()("awthaq/AuthHooks") {
  static readonly layer = Layer.effect(AuthHooks, makeRegistry)   // sorts taps by (topo, order, plugin) at first run, then freezes

  // Contributor sugar — the HttpRouter.use shape.
  static readonly tap = <I, O, E, R>(
    point: HookPoint<I, O>, handler: (input: I) => Effect.Effect<O, E, R>, options?: TapOptions
  ): Layer.Layer<never, never, AuthHooks | R> =>
    Layer.effectDiscard(AuthHooks.use((hooks) => hooks.tap(point, handler, options)))
}
```

Veto points run taps sequentially; a tap may fail with `HookAbort` (typed, mapped to 4xx) or return an amended input. Observe points wrap every tap in `Effect.catchCause` and log, so a failing observer can never fail sign-in. Divert points may return a typed alternative outcome (`TwoFactorRequired`), which is how two-factor wraps sign-in without touching the password plugin.

### 5.4 Events

```ts
// @awthaq/core/src/AuthEvents.ts
export class UserSignedIn extends Schema.TaggedClass<UserSignedIn>()("auth.user.signedIn", {
  userId: UserId, sessionId: SessionId, strategy: Schema.String
}) {}
export const AuthEvent = Schema.Union([UserSignedIn, SessionIssued, SessionRevoked, UserCreated /* … */])

export class AuthEvents extends Context.Service<AuthEvents, {
  publish(event: AuthEvent): Effect.Effect<void>              // never awaits observers
  readonly stream: Stream.Stream<AuthEvent>
}>()("awthaq/AuthEvents") {
  static readonly layer = Layer.effect(AuthEvents, Effect.gen(function*() {
    const pubsub = yield* PubSub.bounded<AuthEvent>({ capacity: 1024 })
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))
    return AuthEvents.of({ publish: (e) => PubSub.publish(pubsub, e), stream: Stream.fromPubSub(pubsub) })
  }))

  // Subscriber sugar: forked into the layer's scope, failures logged, never propagated.
  static readonly on = <Tag extends AuthEvent["_tag"], R>(
    tag: Tag, handler: (event: Extract<AuthEvent, { _tag: Tag }>) => Effect.Effect<void, unknown, R>
  ): Layer.Layer<never, never, AuthEvents | R> =>
    Layer.effectDiscard(Effect.gen(function*() {
      const events = yield* AuthEvents
      yield* events.stream.pipe(
        Stream.filter((e): e is Extract<AuthEvent, { _tag: Tag }> => e._tag === tag),
        Stream.runForEach((e) => handler(e).pipe(Effect.catchCause((c) => Effect.logError("auth.event.observer.error", c)))),
        Effect.forkScoped
      )
    }))
}
```

### 5.5 Errors with reasons

Service methods fail with one wrapper per domain carrying a `reason` union, so endpoint error lists stay short and handlers use `Effect.catchReasons`.

```ts
export class PasswordError extends Schema.TaggedError<PasswordError>()("PasswordError", {
  reason: Schema.Union([InvalidCredentials, EmailTaken, WeakPassword, RateLimited])
}) {}
```

---

## 6. Stratum 5 — HTTP

### 6.1 Implementing `Authentication`

The middleware implementation is a Layer for the service defined in stratum 1. Each security key is a strategy.

```ts
// @awthaq/server/src/Authentication.ts
export const AuthenticationLive: Layer.Layer<Authentication, never, Sessions | PrincipalResolver> = Layer.effect(
  Authentication,
  Effect.gen(function*() {
    const sessions = yield* Sessions
    const principals = yield* PrincipalResolver           // Session → Principal (user, actingAs)

    const fromSession = (credential: Redacted.Redacted<string>) =>
      Effect.gen(function*() {
        if (Redacted.value(credential) === "") return yield* new Unauthenticated({ reason: "missing" })
        const session = yield* sessions.resolve(credential)
        return yield* principals.fromSession(session)
      })

    return Authentication.of({
      cookie: Effect.fn("Authentication.cookie")(function*(httpEffect, { credential }) {
        const principal = yield* fromSession(credential)
        return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal)
      }),
      bearer: Effect.fn("Authentication.bearer")(function*(httpEffect, { credential }) {
        const principal = yield* fromSession(credential)   // a JWT plugin swaps this for a verifier
        return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal)
      })
    })
  })
)
```

Plugins that add a strategy (API keys, JWT) declare their own `HttpApiMiddleware.Service` with its own scheme and apply it to their groups, or contribute a `PrincipalResolver` alternative. The core chain stays two schemes so its order is reviewable in one file.

### 6.2 Implementing `CsrfProtection`

```ts
export const CsrfProtectionLive = Layer.effect(CsrfProtection, Effect.gen(function*() {
  const config = yield* SessionConfig
  const secret = yield* Config.Redacted("AUTH_SECRET")
  return CsrfProtection.of((httpEffect) => Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method === "GET" || request.method === "HEAD") return yield* httpEffect
    // Fetch Metadata first, Origin fallback, then the signed double-submit token.
    const site = Headers.get(request.headers, "sec-fetch-site")
    if (Option.isSome(site) && site.value !== "same-origin" && site.value !== "none") return yield* new CsrfRejected()
    const cookies = yield* HttpServerRequest.schemaCookies(Schema.Struct({ "__Host-csrf": Schema.String })).pipe(Effect.orElseSucceed(() => undefined))
    const header = Headers.get(request.headers, "x-csrf-token")
    if (cookies === undefined || Option.isNone(header) || !verifyHmac(secret, cookies["__Host-csrf"], header.value)) {
      return yield* new CsrfRejected()
    }
    return yield* httpEffect
  }))
}))
```

### 6.3 Handlers

Handlers are `HttpApiBuilder.group` layers built against the plugin's own contract. They call stratum-4 services and map reason unions to declared errors.

```ts
// @awthaq/password/src/http.ts
export const PasswordHandlersNoDeps = HttpApiBuilder.group(PasswordContract, "password", Effect.fn(function*(handlers) {
  const password = yield* Password            // the plugin's domain service
  const sessions = yield* Sessions
  const views = yield* SessionViews

  const issueAndSetCookie = (userId: UserId) => Effect.gen(function*() {
    const { session, token } = yield* sessions.issue({ userId })
    yield* HttpApiBuilder.securitySetCookie(SessionCookie, token, { sameSite: "strict", path: "/" })
    return yield* views.forSession(session)
  })

  return handlers.handleAll({
    signUp: ({ payload }) =>
      password.signUp(payload).pipe(
        Effect.flatMap((user) => issueAndSetCookie(user.id)),
        Effect.catchReasons("PasswordError", {
          EmailTaken: Effect.fail, WeakPassword: Effect.fail, RateLimited: Effect.fail
        }, Effect.die)
      ),
    signIn: ({ payload }) =>
      password.signIn(payload).pipe(
        Effect.flatMap((user) => issueAndSetCookie(user.id)),
        Effect.catchReasons("PasswordError", {
          InvalidCredentials: Effect.fail, RateLimited: Effect.fail
        }, Effect.die),
        Effect.catchTag("Diverted", (d) => Effect.fail(d.outcome))    // TwoFactorRequired from a divert hook
      ),
    requestReset: ({ payload }) => password.requestReset(payload.email).pipe(Effect.orDie),   // always 202
    confirmReset: ({ payload }) => password.confirmReset(payload).pipe(Effect.catchReasons("PasswordError", { InvalidToken: Effect.fail, WeakPassword: Effect.fail }, Effect.die))
  })
}))
```

### 6.4 Serving

```ts
// @awthaq/server/src/AuthHttp.ts
export const AuthHttp = {
  // Registers every group of the merged api with the router; handler layers come from Auth.layer.
  routes: <Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<"auth", Groups>) =>
    HttpApiBuilder.layer(api, { openapiPath: "/auth/openapi.json" }),
  docs: (api: HttpApi.Top) => HttpApiScalar.layer(api, { path: "/auth/docs" })
}
```

```ts
// app/server.ts — the whole server is Effect
const Routes = Layer.mergeAll(
  AuthHttp.routes(AuthApi),
  HttpApiBuilder.layer(AppApi),                 // your own API (§7.4)
  AuthHttp.docs(AuthApi)
).pipe(Layer.provide(AuthLive), Layer.provide(AppHandlers))

Layer.launch(
  HttpRouter.serve(Routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })))
).pipe(NodeRuntime.runMain)

// app/api/auth/[...all]/route.ts — or a web handler for Next, Hono, TanStack
export const { handler } = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(HttpServer.layerServices)))
```

---

## 7. Stratum 6 — Authorization with qadi

### 7.1 The boundary

awthaq produces a `Principal`. qadi consumes an `AuthSubject` (`id`, `roles`, `permissions`, `attributes`). The bridge is one service, `SubjectResolver`, whose default knows nothing about roles. The `roles` and `organization` plugins replace its layer.

```ts
// @awthaq/core/src/SubjectResolver.ts
import { makeSubject, type AuthSubject } from "@qadi/core"

export class SubjectResolver extends Context.Service<SubjectResolver, {
  resolve(principal: Principal): Effect.Effect<AuthSubject>
}>()("awthaq/SubjectResolver") {
  // Default: identity only. No roles, no permissions. Every qadi policy that needs one denies.
  static readonly layer = Layer.succeed(SubjectResolver, {
    resolve: (p) => Effect.succeed(makeSubject({
      id: `${p.ref.type}:${p.ref.id}`,
      attributes: { principal: p._tag, ...(p._tag === "User" && p.actingAs ? { actingAs: p.actingAs.id } : {}) }
    }))
  })
}

// @awthaq/roles — replaces the default with roles loaded from the role table + a role DAG
export const SubjectResolverWithRoles = Layer.effect(SubjectResolver, Effect.gen(function*() {
  const roles = yield* RoleRepo
  const graph = yield* RoleGraph                    // qadi `role({...})` definitions, from config
  return SubjectResolver.of({
    resolve: (p) => p._tag !== "User" ? Effect.succeed(makeSubject({ id: `${p.ref.type}:${p.ref.id}`, permissions: p.scopes as any }))
      : roles.forUser(p.userId).pipe(Effect.map((names) =>
          fromRoles({ id: `user:${p.userId}`, roles: names.map(graph.get), attributes: { actingAs: p.actingAs?.id } })))
  })
}))
```

`SubjectDto` (§2.4) is `AuthSubject` with arrays instead of sets; `GET /auth/session` returns it so the browser can seed `QadiProvider` (§7.6).

### 7.2 Two ways to get a `CurrentSubject` into a request

**A. Middleware that lifts the principal.** For endpoints already behind `Authentication`, a second middleware requires `CurrentPrincipal` and provides qadi's `CurrentSubject`. Handlers then call `guard`, `enforce`, `enforceProjected` directly.

```ts
// @awthaq/qadi/src/AuthorizedSubject.ts
import { CurrentSubject } from "@qadi/core"

export class AuthorizedSubject extends HttpApiMiddleware.Service<AuthorizedSubject, {
  requires: CurrentPrincipal
  provides: CurrentSubject
}>()("awthaq/qadi/AuthorizedSubject") {}

export const AuthorizedSubjectLive = Layer.effect(AuthorizedSubject, Effect.gen(function*() {
  const resolver = yield* SubjectResolver
  return AuthorizedSubject.of((httpEffect) => Effect.gen(function*() {
    const principal = yield* CurrentPrincipal
    const subject = yield* resolver.resolve(principal)
    return yield* Effect.provideService(httpEffect, CurrentSubject, subject)
  }))
}))
```

**B. qadi's own `RequirePermission` middleware,** fed by a `SubjectExtractor` that runs awthaq's session resolution on the raw request. This is the declarative path: the permission is an endpoint annotation, the permission registry can list it, and an endpoint that declares nothing is refused.

```ts
// @awthaq/qadi/src/SubjectExtractor.ts
import { SubjectExtractor, SubjectExtractionFailed } from "@qadi/http"
import { anonymous } from "@qadi/core"

export const SubjectExtractorLive: Layer.Layer<SubjectExtractor, never, Sessions | PrincipalResolver | SubjectResolver> =
  Layer.effect(SubjectExtractor, Effect.gen(function*() {
    const sessions = yield* Sessions
    const principals = yield* PrincipalResolver
    const subjects = yield* SubjectResolver
    return SubjectExtractor.of({
      extract: (request) => Effect.gen(function*() {
        const cookie = Option.fromNullable(Cookies.toRecord(request.cookies)["__Host-session"])
        const bearer = Headers.get(request.headers, "authorization").pipe(Option.map((h) => h.replace(/^Bearer\s+/i, "")))
        const token = Option.orElse(cookie, () => bearer)
        if (Option.isNone(token)) return anonymous
        const session = yield* sessions.resolve(Redacted.make(token.value)).pipe(
          Effect.catchTag("Unauthenticated", () => Effect.succeed(undefined))
        )
        if (session === undefined) return anonymous
        return yield* subjects.resolve(yield* principals.fromSession(session))
      }).pipe(Effect.mapError((e) => new SubjectExtractionFailed({ reason: String(e) })))
    })
  }))
```

Use A when your handler loads a resource and decides against it (most CRUD). Use B for resource-less gates and for the `/__permissions` registry. Both go through qadi's single evaluation path; neither re-implements a check.

### 7.3 Permissions, roles and policies

These are qadi values, defined once at module scope in the app's domain layer.

```ts
// app/domain/authz.ts
import { permission, role, allOf, anyOf, hasPermission, hasRole, hasResourceAttribute, eq, subjectId, createPermissionGroup } from "@qadi/core"

export const project = createPermissionGroup("project", ["read", "update", "delete", "invite"] as const)
export const readProject = permission("project", "read")

export const member = role({ name: "member", permissions: [project.read] })
export const admin  = role({ name: "admin", permissions: [project.update, project.delete, project.invite], inherits: [member] })

export const canReadProject = allOf([
  hasPermission(project.read, { fields: ["id", "name", "summary"] }),   // projection: what the caller may see
  anyOf([hasRole("admin"), hasResourceAttribute("visibility", eq("public")), hasResourceAttribute("ownerId", subjectId())])
])
export const canDeleteProject = allOf([hasPermission(project.delete), hasResourceAttribute("ownerId", subjectId())])
```

### 7.4 Effect HTTP server: the app API with both paths

```ts
// app/api.ts — contract
import { PublicEndpoint, publicEndpoint, RequiredPermission, requiresPermission, RequirePermission } from "@qadi/http"

export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(ProjectView) }),
    HttpApiEndpoint.get("byId", "/:id", { params: { id: ProjectId }, success: ProjectView, error: ProjectNotFound }),
    HttpApiEndpoint.post("remove", "/:id/delete", { params: { id: ProjectId }, success: HttpApiSchema.NoContent, error: ProjectNotFound })
  )
  .middleware(Authentication)          // who
  .middleware(AuthorizedSubject)       // qadi subject in the environment (path A)
  .middleware(CsrfProtection)
  .prefix("/projects")
{}

// Path B: declare the permission on the endpoint, let RequirePermission enforce it.
export class AdminApi extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("stats", "/stats", { success: Stats }).pipe((e) =>
      e.annotate(RequiredPermission, requiresPermission(e, { permission: adminPermission, policy: hasRole("admin") }))
    ),
    HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }).pipe((e) =>
      e.annotate(PublicEndpoint, publicEndpoint("liveness probe, no subject exists yet"))
    )
  )
  .middleware(RequirePermission)       // absence of an annotation is refused with 500, never allowed
  .prefix("/admin")
{}

export class AppApi extends HttpApi.make("app").add(ProjectsApi, AdminApi) {}
```

```ts
// app/handlers.ts
import { enforceProjected, filter, guard } from "@qadi/core"

export const ProjectsHandlers = HttpApiBuilder.group(AppApi, "projects", Effect.fn(function*(handlers) {
  const projects = yield* Projects
  return handlers.handleAll({
    // filter: one evaluation per item, denied items dropped
    list: () => projects.all.pipe(Effect.flatMap((all) => filter(canReadProject, all)), Effect.orDie),

    // enforceProjected: the response only carries the fields the policy grants
    byId: ({ params }) => projects.byId(params.id).pipe(
      enforceProjected(canReadProject),
      Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id: params.id })),   // hide existence cross-tenant
      Effect.catchTag(["AttributeResolveError", "RelationshipResolveError"], Effect.die)
    ),

    // guard: the handler receives an Authorized<typeof project.delete> witness it cannot forge
    remove: ({ params }) => projects.byId(params.id).pipe(
      Effect.flatMap((p) => guard(project.delete, canDeleteProject)(p, (_authorized, resource) => projects.remove(resource.id))),
      Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id: params.id })),
      Effect.orDie
    )
  })
}))
```

```ts
// app/server.ts
import { EvaluationServicesNone, decisionCacheLayer, EvaluationIdLive } from "@qadi/core"
import { RequirePermissionLive, PermissionRegistryLive, registerApi, permissionRegistryRoute } from "@qadi/http"

const QadiLive = Layer.mergeAll(
  EvaluationServicesNone,                 // fail-closed defaults for every optional port
  EvaluationIdLive,
  decisionCacheLayer({ capacity: 512 })
)

const AuthzLive = Layer.mergeAll(
  AuthorizedSubjectLive,
  RequirePermissionLive.pipe(Layer.provide(SubjectExtractorLive))
).pipe(Layer.provide(AuthLive))

const Routes = Layer.mergeAll(
  AuthHttp.routes(AuthApi),
  HttpApiBuilder.layer(AppApi).pipe(Layer.provide([ProjectsHandlers, AdminHandlers])),
  registerApi(AppApi),                                          // seeds the registry from the annotations
  permissionRegistryRoute(adminPermission, hasRole("admin"))   // GET /__permissions, behind that policy
).pipe(
  Layer.provide(AuthzLive),
  Layer.provide(QadiLive),
  Layer.provide(AuthLive),
  Layer.provideMerge(PermissionRegistryLive)
)

Layer.launch(HttpRouter.serve(Routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })))).pipe(NodeRuntime.runMain)
```

### 7.5 In-process, outside HTTP

```ts
const nightly = Effect.gen(function*() {
  const subjects = yield* SubjectResolver
  const subject = yield* subjects.resolve(ServicePrincipal.make({ ref: { type: "service", id: "reports" }, scopes: ["project:read"] }))
  const visible = yield* filter(canReadProject, yield* Projects.all).pipe(Effect.provide(currentSubjectLayer(subject)))
  /* ... */
})
```

### 7.6 React: session from awthaq, decisions from qadi

`@awthaq/react` and `@qadi/react` share one substrate: atoms from `effect/unstable/reactivity`. The auth client is an `AtomHttpApi.Service`; the session atom is a query on `session.current`; its `subject` field feeds `QadiProvider`.

```tsx
// app/client/auth.ts
import { AtomHttpApi } from "effect/unstable/reactivity"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { CsrfProtection } from "@awthaq/api"
import { AuthApi } from "../auth.contract"

// The client half of CsrfProtection. Without this layer the AuthClient does not type-check.
const CsrfClient = HttpApiMiddleware.layerClient(CsrfProtection, ({ next, request }) =>
  next(HttpClientRequest.setHeader(request, "x-csrf-token", readCookie("__Host-csrf") ?? ""))
)

export class AuthClient extends AtomHttpApi.Service<AuthClient>()("app/AuthClient", {
  api: AuthApi,
  httpClient: FetchHttpClient.layer.pipe(Layer.merge(CsrfClient)),
  baseUrl: "/"
}) {}

export const sessionAtom = AuthClient.query("session", "current", {
  reactivityKeys: ["session"], timeToLive: "5 minutes", serializationKey: "auth.session"
})
export const signIn  = AuthClient.mutation("password", "signIn")   // invalidates ["session"] on success
export const signOut = AuthClient.mutation("session", "signOut")
```

```tsx
// app/client/Providers.tsx
"use client"
import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/unstable/reactivity"
import { QadiProvider, hydrateDecisions, makeQadiAtoms } from "@qadi/react"
import { EvaluationServicesNone, EvaluationIdLive, makeSubject } from "@qadi/core"

const qadiAtoms = makeQadiAtoms(Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive))   // module scope

const subjectFromView = (view: SessionView | undefined) =>
  view === undefined ? undefined : makeSubject({
    id: view.subject.id, roles: view.subject.roles, permissions: view.subject.permissions as any, attributes: view.subject.attributes
  })

export const Providers = ({ initialSession, decisions, children }: {
  initialSession: SessionView | undefined
  decisions?: DehydratedDecisions
  children: React.ReactNode
}) => (
  <RegistryProvider initialValues={[[sessionAtom, AsyncResult.success(initialSession)]]}>
    <AuthorizationProviders decisions={decisions}>{children}</AuthorizationProviders>
  </RegistryProvider>
)

const AuthorizationProviders = ({ decisions, children }) => {
  const session = useAtomValue(sessionAtom)
  const subject = subjectFromView(AsyncResult.isSuccess(session) ? session.value : undefined)
  const [initialValues] = useState(() =>
    decisions && subject ? Array.from(hydrateDecisions(qadiAtoms, decisions, subject)) : [])
  return <QadiProvider atoms={qadiAtoms} subject={subject} initialValues={initialValues}>{children}</QadiProvider>
}
```

```tsx
// app/client/ProjectCard.tsx
import { Can, useCan, useProjected } from "@qadi/react"
import { canDeleteProject, canReadProject } from "../domain/authz"

export const ProjectCard = ({ resource }: { resource: ProjectResource }) => {
  const view = useProjected(canReadProject, resource)     // fields the policy grants, nothing else
  return (
    <article>
      <h3>{view.name}</h3>
      <Can policy={canDeleteProject} resource={resource} fallback={null} pending={<Spinner />}>
        <DeleteButton id={resource.id} />
      </Can>
    </article>
  )
}
```

Sign-in refreshes both worlds at once: the mutation invalidates `["session"]`, the session atom refetches, `subject` changes, and `QadiProvider` re-decides. There is no second store.

### 7.7 Next.js with server rendering

Decide on the server, seed the browser, let the browser re-check. Only attributes cross the boundary.

```tsx
// app/projects/page.tsx (React Server Component)
import { decide } from "@qadi/core"
import { dehydrateDecisions } from "@qadi/react"
import { getSession } from "@awthaq/next"          // reads the cookie, runs Sessions.resolve, returns SessionView | undefined

export const dynamic = "force-dynamic"

export default async function Page() {
  const session = await getSession({ headers: await headers() })
  const { views, decisions } = await runtime.runPromise(
    Effect.gen(function*() {
      const subject = yield* SubjectResolver.use((s) => s.resolve(session.principal))
      const projects = yield* Projects.all
      const resources = projects.map(policyResource)                       // attributes only
      const entries = yield* Effect.forEach(resources, (resource) =>
        Effect.map(decide(canDeleteProject, { resource }), (decision) => ({ policy: canDeleteProject, resource, decision })))
      const views = yield* filter(canReadProject, projects)
      return { views, decisions: dehydrateDecisions(entries) }
    }).pipe(Effect.provide(currentSubjectLayer(subject)))
  )
  return (
    <Providers initialSession={session} decisions={decisions}>
      <ProjectList projects={views} />
    </Providers>
  )
}

// app/api/auth/[...all]/route.ts
const { handler } = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(HttpServer.layerServices)))
export { handler as GET, handler as POST }
```

`proxy.ts` may read cookie presence for redirects. It is never the authorization boundary; the handler and the page are.

---

## 8. Stratum 7 — Composition

### 8.1 What a plugin is

```ts
// @awthaq/core/src/Auth.ts
export interface PluginManifest {
  readonly id: string                          // "password" | "acme.invite"
  readonly apiVersion: 1
  readonly version?: string
  readonly requires?: { readonly plugins?: ReadonlyArray<string>; readonly ports?: ReadonlyArray<string> }
  readonly provides?: ReadonlyArray<string>    // port keys this plugin's layer implements (exclusive)
  readonly conflicts?: ReadonlyArray<string>
  readonly tables?: ReadonlyArray<string>      // physical names, must be <id>_ prefixed
}

export interface AuthPlugin<Groups extends HttpApiGroup.Constraint, Provides, E, Requires> {
  readonly manifest: PluginManifest
  readonly contract: HttpApi.HttpApi<"auth", Groups>
  readonly layer: Layer.Layer<Provides | HttpApiGroup.ToService<"auth", Groups>, E, Requires>   // services + handlers + taps
  readonly migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>
}

export const plugin = <Groups extends HttpApiGroup.Constraint, Provides, E, Requires>(
  p: AuthPlugin<Groups, Provides, E, Requires>
): AuthPlugin<Groups, Provides, E, Requires> => Object.freeze(p)
```

That is the whole contract. Everything a plugin does is either data in `manifest`, schemas in `contract`, or Layers in `layer`.

### 8.2 `Auth.api`

```ts
export const api = <const Contracts extends ReadonlyArray<HttpApi.HttpApi<"auth", any>>>(
  contracts: Contracts, options?: { readonly prefix?: `/${string}` }
): HttpApi.HttpApi<"auth", HttpApiGroup.AddPrefix<Groups<Contracts>, Prefix>> => {
  // duplicate group ids across contracts → throws at module evaluation with both contract names
  return contracts.reduce((acc, c) => acc.addHttpApi(c), HttpApi.make("auth")).prefix(options?.prefix ?? "/auth")
}
```

### 8.3 `Auth.link`: the linker

`link` is a pure Effect over manifests. It never builds a Layer, so the CLI runs it without a database.

```ts
export class LinkError extends Schema.TaggedError<LinkError>()("LinkError", {
  code: Schema.Literals(["E_PLUGIN_DUPLICATE_ID", "E_PLUGIN_MISSING_DEP", "E_PLUGIN_CYCLE", "E_API_VERSION_UNSUPPORTED",
                         "E_PORT_CONFLICT", "E_GROUP_CONFLICT", "E_TABLE_CONFLICT", "E_NAMESPACE_RESERVED"]),
  message: Schema.String,
  plugins: Schema.Array(Schema.String),
  path: Schema.optional(Schema.Array(Schema.String))
}) {}

export interface Linked {
  readonly order: ReadonlyArray<string>                                             // topological
  readonly migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>   // re-keyed NNNN_<plugin>_<name>
  readonly manifest: { readonly plugins: ReadonlyArray<PluginManifest>; readonly groups: ReadonlyArray<string>; readonly hash: string }
}

export const link = (plugins: ReadonlyArray<AuthPlugin.Any>): Effect.Effect<Linked, LinkError> => /* Kahn + checks */ null!
```

### 8.4 `Auth.layer`

```ts
export const layer = <const Plugins extends ReadonlyArray<AuthPlugin.Any>>(plugins: Plugins): Layer.Layer<
  AuthCore | AuthPlugin.Provides<Plugins[number]>,        // core services + every plugin's public services + handler groups
  LinkError | AuthPlugin.Error<Plugins[number]> | ConfigError,
  SqlClient.SqlClient | AuthPlugin.Requires<Plugins[number]>
> =>
  Layer.unwrap(Effect.gen(function*() {
    yield* link(plugins)                                                  // fail before any layer is built
    const core = Layer.mergeAll(Users.layerNoDeps, Sessions.layerNoDeps, Accounts.layerNoDeps, Verification.layerNoDeps,
                                AuthHooks.layer, AuthEvents.layer, SubjectResolver.layer, PrincipalResolver.layer,
                                SessionViews.layer, AuthenticationLive, CsrfProtectionLive, CoreHandlers)
    return Layer.mergeAll(...plugins.map((p) => p.layer)).pipe(Layer.provideMerge(core))
  }))
```

Types stay shallow: `Plugins[number]["layer"]` indexed accesses, never conditional merges.

### 8.5 The application, end to end

```ts
// app/auth.ts
import { Auth } from "@awthaq/core"
import { password } from "@awthaq/password"
import { passkey } from "@awthaq/passkey"
import { organization } from "@awthaq/organization"
import { roles } from "@awthaq/roles"
import { PasswordHasher, Mailer } from "@awthaq/ports"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { RateLimiter, KeyValueStore } from "effect/unstable/persistence"

const plugins = [
  password({ breachCheck: true }),
  passkey({ rpId: "example.com", origins: ["https://example.com"] }),
  organization(),
  roles({ graph: [member, admin] }),
  companyEmail()                                        // §10, twelve lines
] as const

export const AuthApi = Auth.api(plugins.map((p) => p.contract))

const Sql = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })
const Migrations = Layer.unwrap(Effect.map(Auth.link(plugins), (linked) =>
  PgMigrator.layer({ loader: PgMigrator.fromRecord({ ...coreMigrations, ...linked.migrations }) })))

export const AuthLive = Auth.layer(plugins).pipe(
  Layer.provide(Layer.succeed(SessionConfig, { ...SessionConfig.defaultValue(), idle: Duration.days(1) })),
  Layer.provide(PasswordHasher.layerArgon2id),
  Layer.provide(Mailer.layerSes),
  Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreRedisConfig({ url: Config.Redacted("REDIS_URL") })))),
  Layer.provide(KeyValueStore.layerMemory),
  Layer.provide(Migrations.pipe(Layer.provideMerge(Sql))),
  Layer.provide(NodeServices.layer)                     // Crypto, FileSystem, Path
)
```

Nothing here is a framework primitive. It is `Layer.provide` all the way down, which is what makes the tenant seam (§11) and the test seam (§12) free.

---

## 9. Client

```ts
// non-React consumers
const program = Effect.gen(function*() {
  const client = yield* HttpApiClient.make(AuthApi, { baseUrl: "https://app.example.com" })
  const view = yield* client.password.signIn({ payload: { email, password: Redacted.make(secret) } })
  //    Effect<SessionView, InvalidCredentials | RateLimited | TwoFactorRequired | HttpClientError | SchemaError>
}).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, CsrfClient)))   // CsrfClient is required by the type
```

Bearer-mode clients (native apps) add `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))` through `transformClient` and skip `CsrfClient` by using `AuthApi` variants whose groups do not carry `CsrfProtection`, which `Auth.api` produces with `{ csrf: false }` for the bearer contract.

`$ERROR_CODES` is derived from the contract: the union of every endpoint error `_tag`, exported as a type and a runtime array for i18n catalogs.

---

## 10. Writing a plugin

### 10.1 Twelve lines: a sign-up policy

```ts
export const companyEmail = () => Auth.plugin({
  manifest: { id: "acme.company-email", apiVersion: 1 },
  contract: HttpApi.make("auth"),
  migrations: {},
  layer: AuthHooks.tap(Hooks.beforeSignUp, (input) =>
    input.email.endsWith("@acme.com") ? Effect.succeed(input)
      : HookAbort.fail({ code: "EMAIL_DOMAIN_NOT_ALLOWED", message: "Use your company address." }))
})
```

### 10.2 Full plugin: invitations

```
packages/plugin-invite/src/
  api.ts          contract (stratum 1)      → "@acme/awthaq-invite/api"
  Invitation.ts   Model.Class (stratum 3)
  Invites.ts      domain service (stratum 4)
  http.ts         handlers (stratum 5)
  index.ts        Auth.plugin (stratum 7)
```

```ts
// api.ts
export class InviteApi extends HttpApiGroup.make("invite")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: { email: Email, role: Schema.Literals(["member", "admin"]) },
      success: Schema.Struct({ id: Schema.String, expiresAt: Schema.DateTimeUtcFromString }),
      error: [RateLimited]
    }).pipe((e) => e.annotate(RequiredPermission, requiresPermission(e, { permission: project.invite, policy: hasPermission(project.invite) }))),
    HttpApiEndpoint.post("accept", "/:token/accept", {
      params: { token: Schema.RedactedFromValue(Schema.String) },
      success: SessionView,
      error: [InviteNotFound, InviteExpired]
    }).pipe((e) => e.annotate(PublicEndpoint, publicEndpoint("the invitee has no account yet")))
  )
  .middleware(Authentication)
  .middleware(RequirePermission)
  .middleware(CsrfProtection)
  .prefix("/invite")
{}
export class InviteContract extends HttpApi.make("auth").add(InviteApi) {}
```

```ts
// Invitation.ts
export class Invitation extends Model.Class<Invitation>("Invitation")({
  id: Model.UuidV7Insert(InvitationId),
  email: Schema.String,
  role: Schema.Literals(["member", "admin"]),
  tokenHash: Model.Sensitive(Schema.String),
  invitedBy: UserId,
  expiresAt: Schema.DateTimeUtcFromString,
  acceptedAt: Model.FieldOption(Schema.DateTimeUtcFromString),
  createdAt: Model.DateTimeInsert
}) {}

export const migrations = {
  "0001_invite_invitation": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE invite_invitation (id TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL,
               token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL REFERENCES auth_user(id) ON DELETE SET NULL,
               expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL)`
    yield* sql`CREATE INDEX invite_invitation_email_idx ON invite_invitation (email)`
  })
}
```

```ts
// Invites.ts
export class Invites extends Context.Service<Invites, {
  create(input: { email: string; role: "member" | "admin" }): Effect.Effect<Invitation, InviteError>
  accept(token: Redacted.Redacted<string>): Effect.Effect<User, InviteError>
}>()("acme/awthaq-invite/Invites") {
  static readonly layerNoDeps = Layer.effect(Invites, Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* SqlModel.makeRepository(Invitation, { tableName: "invite_invitation", spanPrefix: "Invites", idColumn: "id" })
    const crypto = yield* Crypto.Crypto
    const mailer = yield* Mailer
    const hooks = yield* AuthHooks
    const events = yield* AuthEvents
    const limiter = yield* RateLimiter.RateLimiter
    const principal = yield* CurrentPrincipal        // request-scoped: provided by Authentication

    const create = Effect.fn("Invites.create")(function*(input) {
      yield* limiter.consume({ key: `invite:${principal.ref.id}`, limit: 10, window: "10 minutes" }).pipe(
        Effect.mapError(() => new InviteError({ reason: new RateLimited({ retryAfterMillis: 600_000 }) })))
      const amended = yield* hooks.run(beforeInvite, input)
      const secret = yield* crypto.randomBytes(32)
      const row = yield* Invitation.insert.makeEffect({
        ...amended, tokenHash: Encoding.encodeHex(yield* crypto.digest("SHA-256", secret)),
        invitedBy: principal.ref.id as UserId, expiresAt: DateTime.add(yield* DateTime.now, Duration.days(7))
      }).pipe(Effect.flatMap(repo.insert), Effect.orDie)
      yield* mailer.send({ to: amended.email, template: "invite", data: { token: Encoding.encodeBase64Url(secret) } })
      yield* events.publish(new InviteCreated({ invitationId: row.id }))
      return row
    })
    return Invites.of({ create, accept: /* consume token + create user in one transaction */ null! })
  }))
}
```

```ts
// index.ts
export const invite = (options?: { readonly ttl?: Duration.Input }) => Auth.plugin({
  manifest: {
    id: "acme.invite", apiVersion: 1, version: "1.0.0",
    requires: { plugins: ["password"], ports: ["awthaq/ports/Mailer"] },
    tables: ["invite_invitation"]
  },
  contract: InviteContract,
  migrations,
  layer: Layer.mergeAll(
    Invites.layerNoDeps,
    InviteHandlers,                                                   // HttpApiBuilder.group(InviteContract, "invite", …)
    AuthEvents.on("auth.user.deleted", ({ userId }) => Invites.use((i) => i.purgeFor(userId)))
  )
})
```

Options parameterize Layers only. The contract, the migrations and the manifest are static, so `awthaq plugin list` and the registry validator read them without executing anything.

---

## 11. Multi-tenancy and key rotation

```ts
// per-tenant OAuth provider credentials, cached and released when idle
export class TenantProviders extends LayerMap.Service<TenantProviders>()("app/TenantProviders", {
  lookup: (tenantId: string) => OAuthProviders.layerFromConfig(tenantId),   // reads AUTH_OAUTH_<tenant>_* via Config
  idleTimeToLive: "10 minutes"
}) {}
// in a request: Effect.provide(TenantProviders.get(tenantId))

// a rotatable JWKS key ring for the jwt plugin
export class KeyRing extends LayerRef.Service<KeyRing>()("awthaq/jwt/KeyRing", {
  layer: SigningKeys.layerFromStore,           // loads current + previous keys
  idleTimeToLive: "1 hour"
}) {}
// rotation endpoint: yield* KeyRing.refresh
```

A tenant selects among installed plugins; it cannot add one. The manifest is validated once at link time; tenant settings are validated against it at boot.

---

## 12. Testing

```ts
// app tests: the whole HTTP pipeline, no server, no database, deterministic time
import { layer } from "@effect/vitest"
import { HttpApiTest } from "effect/unstable/httpapi"
import { TestClock } from "effect/testing"
import { TestAuth } from "@awthaq/test"

const TestLive = TestAuth.layer(plugins)      // Auth.layer over *.layerMemory, Mailer.layerMemory, permissive RateLimiter, HttpServer.layerServices
const makeClient = HttpApiTest.groups(AuthApi, ["password", "session"])

layer(TestLive)("password", (it) => {
  it.effect("idle expiry", () => Effect.gen(function*() {
    const client = yield* makeClient
    yield* client.password.signUp({ payload: { email: "a@b.c", password: Redacted.make("correct horse battery staple") } })
    yield* TestClock.adjust("8 days")
    const err = yield* client.session.current().pipe(Effect.flip)
    assert.strictEqual(err._tag, "Unauthenticated")
  }).pipe(Effect.provide(TestAuth.csrfClient)))
})
```

```ts
// authorization tests: qadi's deterministic layers
import { qadiTestLayer, subjectWith } from "@qadi/testing"
it.effect("owner may delete", () =>
  check(canDeleteProject, { resource: { ownerId: "user:u1" } }).pipe(
    Effect.provide(currentSubjectLayer(subjectWith({ id: "user:u1", permissions: [project.delete] }))),
    Effect.provide(qadiTestLayer()),
    Effect.map((allowed) => assert.isTrue(allowed))))
```

```ts
// partial doubles
Layer.mock(Mailer, { send: () => Effect.void })
```

Plugin contract tests (`runPluginContractTests(invite)`) assert: manifest legality, group id uniqueness, table prefixes, migrations determinism, veto-only-in-veto-points, observer isolation, no `Redacted` value in spans, and that `options` do not change the contract hash.

---

## 13. Decisions and trade-offs

| Topic | v0.2 decision | Why |
|---|---|---|
| Plugin shape | `{ manifest, contract, layer, migrations }` | everything else is a v4 primitive already |
| Strategy chain | security schemes on one middleware, declaration order | verified in `HttpApiBuilder.makeSecurityMiddleware`; no private runtime |
| Present-but-invalid credential | 401 from the last scheme; invalid credentials logged and counted at the scheme that saw them | v4 falls through on failure; the outcome is still a typed 401, so no downgrade |
| Hooks and events | registry services filled by `Layer.effectDiscard` | same pattern as `HttpRouter.use`, `registerApi` |
| Storage | `Model.Class` + `SqlModel` + stock `Migrator` | the ecosystem's drivers implement it; the diff planner is a CLI layer on top |
| Authorization | qadi, two integration paths (`AuthorizedSubject`, `SubjectExtractor` + `RequirePermission`) | one evaluation path, declared-never-inferred endpoints, projections |
| Client | `AtomHttpApi.Service` + `layerClient` for CSRF | the type system enforces the CSRF header |
| Config | `Context.Reference` + `Config.Redacted` | defaults are services; secrets never in objects |
| Tenants / keys | `LayerMap.Service`, `LayerRef.Service` | idle release and refresh come for free |

Open (unchanged from v0.1): npm scope, session lifetime defaults, registry policy, whether third parties may override core groups (proposal: no, `E_GROUP_CONFLICT`).
