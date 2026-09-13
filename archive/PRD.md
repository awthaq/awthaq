> **Superseded as the canonical specification by `spec/` (see `spec/README.md`).**
> Retained here as design rationale and historical record; where the two disagree, `spec/` governs.

# Effect Native Auth — Product Requirements Document

Version 2.0 — 2026-09-12. Supersedes v1. This revision incorporates the research corpus (`research/`), the better-auth contract analysis (`better-auth/`), and the design series in `design/`:

- `design/api-design.md` — v0.1, first concrete API (Effect v3 idioms, retained for the research trace)
- `design/api-design-v4.md` — v0.2, seven strata on Effect v4
- `design/plugins-as-layers.md` — **v0.3, the plugin model this PRD adopts**
- `design/usage-examples-v4.md`, `design/usage-qadi.md` — usage cookbooks

What changed from v1, in one paragraph: the target is Effect v4; plugins are `Context.Service` classes whose Layers carry their requirements, so missing plugins, missing ports and conflicts are compile errors; authorization is delegated to qadi rather than built in; the "plugin compiler" shrank to a linker for cycle detection and migration order; the client and React bindings derive from the HTTP contract through v4's own `AtomHttpApi`.

---

## 1. Product overview

### 1.1 Product name

**Effect Native Auth**. Working npm scope `@effect-auth/*`. The scope is already taken on npm by an abandoned alpha (research 01); a rename is a pending decision and every example below treats the scope as a placeholder.

### 1.2 Vision

A TypeScript authentication runtime built natively on Effect v4, whose differentiator is not the feature list but the composition model: every capability is a service, every contribution is a Layer, and the application's dependency graph is checked by the TypeScript compiler before anything runs.

### 1.3 Thesis

> Authentication capabilities are Effect services. Features are plugins that are themselves services. Installing a plugin is providing a Layer. Whatever the Layer still requires is what the application still has to provide, and the type checker says so.

Authorization is a separate concern with its own library: **qadi** (`@qadi/*`, by the same author). effect-auth resolves *who is asking*; qadi decides *what they may do and what they may see*.

---

## 2. Problem

Effect provides dependency injection, resource management, typed errors, schemas and HTTP APIs, but no first-party authentication runtime. Teams wrap Promise-based frameworks in `Effect.tryPromise`, losing typed errors, Layer lifecycle and the ability to reason about the dependency graph.

The dominant framework, better-auth (Vercel-owned since 2026-07), demonstrates demand for an extensible auth platform and also demonstrates the failure modes of an untyped plugin model: no dependency declarations, no compatibility gate, silent last-wins merges for routes and schema columns, client types inferred by convention, and fourteen security advisories in one 2026 cycle (research 02). Effect Native Auth is the typed counter-thesis.

---

## 3. Goals

- **G1 Effect-native.** Every runtime capability is a `Context.Service`; every contribution is a `Layer`; every error is a `Schema.TaggedError`; every contract is an `HttpApi`.
- **G2 Type-checked composition.** A missing plugin, a missing port implementation, a duplicate plugin id, two plugins overriding the same slot, a tap on an undefined hook point, or a contract without handlers is a compile error.
- **G3 Contract first.** The `HttpApi` contract is written first and alone, is importable in the browser without server code, and drives handlers, client, OpenAPI and tests.
- **G4 Layered.** Seven strata with a Layer boundary at each; dependencies point downward only.
- **G5 Database independence.** Persistence is `Model.Class` plus repositories over `SqlClient`; adapters are the Effect SQL driver packages.
- **G6 Secure by default.** Hashed session secrets, `__Host-` cookies, CSRF enforced on the client type, argon2id, single-use tokens, uniform enumeration-safe errors.
- **G7 Small application surface.** `Auth.make([...])` and a stack of `Layer.provide` is the whole wiring.

---

## 4. Non-goals

The initial product will not: host identity as a service; implement every OAuth provider; support every database on day one; load plugins at runtime; be a general application plugin system; be an ORM or a mail provider; **implement authorization** (qadi does); implement every enterprise protocol in v1.

---

## 5. Design principles

1. **Capability over implementation.** Plugins depend on ports (`PasswordHasher`, `Mailer`); the application provides implementations.
2. **Plugins require ports, never provide them.** A port implementation is a Layer, not a plugin. This removes a whole class of conflicts.
3. **Declarative, frozen, static.** Contracts, tables and migrations are static class members; only Layers see configuration.
4. **Configuration is a service with a default.** Options are `Context.Reference` values overridden by Layers, so per-tenant and per-test overrides need no new mechanism.
5. **One source of truth per concept.** One contract per group, one model per table, one evaluator for authorization.
6. **Typed failures with reasons.** Domain services fail with one wrapper per domain carrying a `reason` union; handlers use `Effect.catchReasons`.
7. **Failure is not denial; absence is refusal.** Inherited from qadi and applied to authentication too.

---

## 6. Target users

Effect application developers (primary), plugin authors, adapter and framework-integration authors. Documentation is organized by those three audiences (§20).

---

## 7. Core concepts

| Concept | Definition |
|---|---|
| **Principal** | Who is asking: `UserPrincipal` (with `sessionId`, optional `actingAs`), `ApiKeyPrincipal`, `ServicePrincipal`, `AnonymousPrincipal`. A `Schema.Union` of `Schema.TaggedClass`es carrying a Zanzibar-shaped `PrincipalRef { type, id }`. |
| **Subject** | qadi's `AuthSubject` derived from a Principal by the `SubjectResolver` slot: id, roles, permissions, attributes. |
| **User / Account / Session / VerificationToken** | `Model.Class` entities. Sessions store only `SHA-256(secret)`; accounts key on `(provider, subject)`. |
| **Plugin** | A `Context.Service` class with static `contract`, `tables`, `migrations` and a `layer` that provides the plugin and its handler groups. |
| **Port** | A service a plugin requires and the application provides: `Crypto`, `KeyValueStore`, `RateLimiter`, `SqlClient` (from Effect), `PasswordHasher`, `Mailer`, `WebAuthn` (from `@effect-auth/ports`). |
| **Slot** | A `Context.Reference` with a fail-closed default that at most one plugin may override (`SubjectResolver`, `SessionViewExtension`). |
| **Hook point** | A service holding a registry cell; veto points may abort or amend, observe points are fail-isolated. |
| **Registry** | An aggregating service filled by `Layer.effectDiscard` writes: hook taps, event subscribers, rate-limit rules, session claims. |

---

## 8. Architecture: the seven strata

```
7  Composition     Auth.make · the application's Layer.provide stack
6  Authorization   @qadi/core · @qadi/http · @qadi/react · @effect-auth/qadi bridges
5  HTTP            HttpApiBuilder groups · middleware implementations · HttpRouter
4  Domain          Users · Sessions · Accounts · Verification · Authentication · hook points · events
3  Persistence     Model.Class · SqlModel repositories · Migrator records
2  Ports           Crypto · KeyValueStore · RateLimiter · SqlClient · PasswordHasher · Mailer · WebAuthn
1  Contract        Schemas · errors · HttpApiGroup · HttpApi · middleware definitions   (isomorphic)
```

Rules: a stratum depends only on strata below it; each service exposes `layerNoDeps` / `layer` / `layerMemory`; stratum 1 has no server code and is what the client imports.

### 8.1 Package map

| Stratum | Package | Contents |
|---|---|---|
| 1 | `@effect-auth/api` | `Principal`, `SessionView`, `SubjectDto`, errors, `Authentication` and `CsrfProtection` middleware definitions, core groups |
| 1 | `@effect-auth/<plugin>/api` | each plugin's groups, schemas, errors, contract `HttpApi` |
| 2 | `@effect-auth/ports` | `PasswordHasher`, `Mailer`, `WebAuthn` with `layer`, `layerNoop`, `layerMemory` |
| 3 | `@effect-auth/sql` | models, repositories, migration records, memory twins |
| 4 | `@effect-auth/core` | domain services, hook points, `AuthEvents`, config references, slots, `Auth` namespace |
| 5 | `@effect-auth/server` | middleware implementations, core handlers, `AuthHttp` |
| 6 | `@effect-auth/qadi` | `AuthorizedSubject` middleware, `SubjectExtractor` layer, obligation handlers |
| client | `@effect-auth/client`, `@effect-auth/react`, `@effect-auth/next` | `AtomHttpApi` client, session atom, provider glue, framework adapters |
| tools | `@effect-auth/test`, `@effect-auth/cli` | `TestAuth`, contract tests, `doctor`, migrations, `openapi` |
| plugins | `@effect-auth/password`, `oauth`, `passkey`, `magic-link`, `two-factor`, `organization`, `roles`, `api-key`, `admin` | one class each |

---

## 9. Plugin system

### 9.1 A plugin is a service class

```ts
export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", {
  apiVersion: 1,
  contract: PasswordApi,                 // HttpApi<"auth", groups named "password" | "password.*">
  tables: ["password_account"],          // must start with "password_"
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Password, {
    dependsOn: [Sessions, Users],        // typed requirement and migration order, one declaration
    make: Effect.gen(function*() {
      const hasher = yield* PasswordHasher     // port: required, never provided
      const config = yield* PasswordConfig     // Context.Reference with defaults
      const before = yield* BeforeSignUp       // hook point, as a service
      /* … */
      return Password.of({ signUp, signIn, requestReset, confirmReset })
    }),
    handlers: PasswordHandlers           // HttpApiBuilder.group(PasswordContract, "password", …)
  })
  static readonly config = (c: Partial<PasswordConfigShape>) => Layer.succeed(PasswordConfig, { ...defaults, ...c })
}
// Password.layer : Layer<Password | HttpApiGroup.Service<"auth","password">, never,
//                        Sessions | Users | PasswordHasher | Mailer | RateLimiter | BeforeSignUp | SqlClient | Crypto>
```

Application code depends on a plugin as on any service: `const password = yield* Password`.

### 9.2 What the type checker enforces

| Situation | Where it fails |
|---|---|
| plugin B needs plugin A, A absent | `Auth.make` names it; `Layer.launch` leaves `A` in `RIn` |
| a port has no implementation | `Layer.launch` leaves the port in `RIn` |
| contract without handlers, or the reverse | impossible: `api` and `layer` come from one tuple |
| duplicate plugin id | `Auth.make` |
| two plugins override one slot | `Auth.make` |
| tap on an undefined hook point | `Layer.launch` |
| group or table outside the plugin's namespace | plugin definition |
| plugin from another Plugin API generation | `Auth.make` (`apiVersion: 1` literal) |
| two plugins implement one port | cannot happen by construction |

Runtime keeps two checks: cycles in `dependsOn` and migration ordering (core first, then topological, keys `NNNN_<plugin>_<name>`).

### 9.3 Richer options

- **Config as Layers**: `Password.config({ minLength: 16 })`; per tenant through `LayerMap.Service`.
- **Variants**: alternative static layers (`Password.layerNoReset` drops `Mailer` from `RIn`).
- **Slots**: exclusive `Context.Reference` overrides, conflict-checked.
- **Hook points**: services; veto (abort or amend), observe (fail-isolated), divert (typed alternative outcome, used by two-factor).
- **Registries**: aggregating contributions ordered by dependency, then `order`, then id.
- **Core is a plugin tuple** (`Users`, `Accounts`, `Sessions`, `Verification`, `Authentication`, `Csrf`, `SessionView`) prepended by `Auth.make`.

### 9.4 `Auth.make`

```ts
export const auth = Auth.make([Password, Passkey, OAuth, Organization, Roles])
//   auth.api        HttpApi<"auth", core groups | every plugin's groups>
//   auth.layer      Layer<AuthCore | Password | …, E, exactly the ports still to provide>
//   auth.migrations Migrator record, ordered
//   auth.manifest   derived, for the CLI
```

`Validate<P>` is pairwise over the tuple; fifty plugins is cheap. Nothing recurses into plugin internals.

---

## 10. Contract (stratum 1)

- Identity schemas, `SessionView { principal, user, session, subject }`, `SubjectDto` (qadi subject with arrays).
- Errors are `Schema.TaggedError` with `{ httpApiStatus }`; `InvalidCredentials` is uniform to prevent enumeration.
- `Authentication` is one `HttpApiMiddleware.Service` with `security: { cookie: SessionCookie, bearer }`. v4 tries schemes in declaration order and returns the first success; the record *is* the strategy chain. `OptionalAuthentication` yields an anonymous principal instead of 401.
- `CsrfProtection` declares `requiredForClient: true`, so a generated client does not type-check without the client half.
- Core groups: `session` (current, list, signOut, revoke, revokeOthers). Plugin groups mount under `/<pluginId>`; core owns the root.
- Applications merge contracts with `Auth.api` (sugar for `HttpApi.addHttpApi`), which refuses duplicate group ids.

---

## 11. Ports (stratum 2)

| Port | Owner | Default |
|---|---|---|
| `Crypto` | `effect/Crypto` | platform layer |
| `KeyValueStore`, `RateLimiter` | `effect/unstable/persistence` | memory, SQL, Redis stores |
| `SqlClient` | `effect/unstable/sql` | `@effect/sql-pg`, `@effect/sql-sqlite-node` |
| `PasswordHasher` | `@effect-auth/ports` | `layerArgon2id`; `layerScrypt` for WebCrypto-only runtimes |
| `Mailer` | `@effect-auth/ports` | `layerNoop` (fails loudly in production), `layerMemory` |
| `WebAuthn` | `@effect-auth/ports` | `layerSimpleWebAuthn` |

---

## 12. Persistence (stratum 3)

- `Model.Class` per entity; `Model.Sensitive` for hashes and secrets so they never appear in JSON variants; `Model.UuidV7Insert` ids.
- Repositories via `SqlModel.makeRepository` plus `SqlSchema` queries; keyset pagination only.
- Migrations are v4 `Migrator` records exported per plugin; the linker orders and re-keys them; the driver's migrator applies them.
- Snapshot-diff planning with a checksum ledger and destructive-change guardrails (research 10) is a CLI feature layered on top, not a v1 runtime requirement.

---

## 13. Domain (stratum 4)

- `Sessions`: opaque `id.secret` tokens, SHA-256 at rest, absolute plus idle expiry from `SessionConfig`, throttled sliding refresh, new session at sign-in and privilege change, device list and revocation.
- `Users`, `Accounts` (cannot unlink the last credential), `Verification` (purpose-scoped single-use tokens; replay publishes `auth.token.replay`).
- `Authentication` implementation: cookie and bearer handlers over `Sessions` and `PrincipalResolver`.
- Hook points: `BeforeSignUp`, `BeforeSignIn`, `BeforeSessionIssue` (divert), `AfterSignUp`, `AfterSignIn`, `BeforeUserDelete`.
- `AuthEvents`: bounded `PubSub`, publishers never await, subscribers forked and isolated; the audit table is the record of record.
- Config references: `SessionConfig`, per-plugin configs. Secrets only via `Config.Redacted` inside layers.

---

## 14. HTTP (stratum 5)

- Handlers are `HttpApiBuilder.group` layers against each plugin's own contract; group service keys derive from the group id, so they satisfy the merged `AuthApi`.
- `AuthHttp.routes(auth.api)` registers the API with the router; `AuthHttp.docs` serves Scalar.
- Serving: `HttpRouter.serve` with a platform server, or `HttpRouter.toWebHandler` for Next.js, Hono, TanStack and any `Request → Response` host.
- CSRF: `Sec-Fetch-Site`, `Origin` fallback, signed double-submit `__Host-csrf`.

---

## 15. Authorization (stratum 6): qadi

effect-auth ships no permission model, no policy language and no authorizer. It ships the bridge to qadi.

- **`SubjectResolver` slot.** Default: identity only. The `roles` plugin overrides it with roles from its table flattened through a qadi role DAG; API-key scopes become permissions; impersonation is `attributes.actingAs`.
- **Path A**: `AuthorizedSubject` middleware requires `CurrentPrincipal` and provides qadi's `CurrentSubject`; handlers use `guard`, `enforce`, `enforceProjected`, `filter`, `decide`.
- **Path B**: `SubjectExtractor` layer runs effect-auth's session resolution on the raw request so qadi's `RequirePermission` enforces `requiresPermission` annotations; unannotated endpoints are refused; the permission registry route lists guarded paths behind a policy.
- **Resolvers from auth data**: attributes from the user table, relationships from organization membership (`Organization.relationships`), decision history from audit events.
- **Obligations**: `ObligationHandlers.reauth` discharges a step-up obligation from session freshness.
- **SQL pushdown**: `toPredicate` plus `@qadi/predicate-sql` inside `SqlClient` queries.
- **Audit**: `DecisionSink` composed with the effect-auth audit trail; guarded decision stream for devtools.
- **Rules**: failure is not denial (502 vs 403); absence is refusal; decide against attributes, not content; a stale decision is not a decision; one evaluation path.

---

## 16. Client and React

- `HttpApiClient.make(auth.api)` for Effect clients; `AtomHttpApi.Service` for reactive clients; `HttpApiMiddleware.layerClient(CsrfProtection, …)` supplies the CSRF header and is required by the client type.
- `sessionAtom = AuthClient.query("session", "current", { reactivityKeys: ["session"] })`; mutations invalidate `["session"]`.
- React: `RegistryProvider` from `@effect/atom-react` seeds the session atom; the session's `subject` feeds `QadiProvider`; gates are qadi's `Can`, `Cannot`, `useCan`, `useProjected`, `usePolicies`.
- Next.js: `getSession` reads the cookie and verifies against the database; pages decide on the server with `decide` and seed the browser with `dehydrateDecisions`; `proxy.ts` is an optimistic redirect, never the boundary; `withNextCookies` bridges `Set-Cookie` from server actions.
- Bearer mode for native clients via `Auth.api(…, { csrf: false })` and `HttpClientRequest.bearerToken`.
- Error codes derive from the contract for i18n catalogs.

---

## 17. Official plugins

| Phase | Plugins |
|---|---|
| MVP | `Password`, `OAuth` (Google, GitHub, generic OIDC; explicit linking by default), `Passkey`, `Roles` (subject resolver over a role table) |
| 2 | `TwoFactor` (divert hook, hashed recovery codes), `MagicLink`, `EmailOtp`, `Organization` (membership, invitations, relationship resolver), `ApiKey` (service principals), `Admin` (impersonation with hard expiry and `actingAs`), `Jwt` (EdDSA, JWKS on `LayerRef`), `Bearer` |
| 3 | `Sso`, `Saml`, `OidcProvider`, `Scim`, `DeviceAuthorization` |

Every official plugin is one class following §9.1 and ships its `/api` subpath.

---

## 18. Security model

Unchanged in substance from v1, now with enforcement points named:

- Session secrets hashed at rest; constant-time comparison via `Crypto.digest` equality on fixed-length hashes.
- Cookies `__Host-session; Secure; HttpOnly; SameSite=Strict; Path=/`.
- CSRF enforced server-side and required by the client type.
- Passwords argon2id by default, PHC strings, rehash on login, optional breach check with an explicit fail-open/closed policy.
- Verification tokens purpose-scoped, hashed, single-use in-transaction; replay is an event.
- OAuth: PKCE S256, server-side state, explicit linking, `(provider, subject, issuer)` uniqueness.
- Impersonation off by default, admin-gated, reason required, hard expiry, dual identity, audit events.
- Redaction: passwords and tokens travel as `Redacted`; contract tests assert no `Redacted` value reaches spans or events.

---

## 19. Testing

- `TestAuth.layer(plugins)`: `Auth.make` over memory repositories, `Mailer.layerMemory`, permissive `RateLimiter`, `HttpServer.layerServices`.
- `HttpApiTest.groups(auth.api, [...])` for whole-pipeline tests with `TestClock`.
- `Layer.mock` for partial doubles; `@qadi/testing` (`qadiTestLayer`, `subjectWith`, recording resolvers) for authorization.
- `runPluginContractTests(plugin)`: manifest legality, group ids, table prefixes, migration determinism, veto-only-in-veto-points, observer isolation, redaction, options-do-not-change-contract.

---

## 20. Documentation

Three audiences. Application developer: getting started, sessions, sign-in methods, protecting endpoints, authorization with qadi, client, React, Next.js, configuration, security. Plugin author: the service class, contracts, tables and migrations, config references, hook points, slots, registries, tests, publishing. Adapter author: ports, drivers, framework adapters, contract tests.

---

## 21. CLI

`effect-auth doctor` (link, config, insecure defaults), `plugin list --graph`, `routes`, `schema`, `migration status|apply`, `openapi`, `seed admin`, `import --from better-auth|authjs|lucia`. The CLI reads `Auth.make`'s derived manifest; it never runs the application.

---

## 22. Architectural decisions

| ADR | Decision |
|---|---|
| ADR-001 | Plugins contribute Effect Layers (kept) |
| ADR-002 | Plugin graph and service graph are separate — **revised**: the plugin graph is *read off* the service graph; only cycle detection and migration order remain runtime |
| ADR-003 | `HttpApi` is the API contract (kept; v4 `effect/unstable/httpapi`) |
| ADR-004 | Database-neutral models — **revised**: `Model.Class` plus `SqlClient`; the schema IR and diff planner move to the CLI |
| ADR-005 | Static composition (kept) |
| ADR-006 | Runtime configuration separate from installation (kept; realized as `Context.Reference` overrides and `LayerMap`) |
| ADR-007 | **Target Effect v4.** Stability of the rc line is the project's own risk to carry; the substrate (multi-scheme middleware, `addHttpApi`, `Model`, `AtomHttpApi`, `LayerMap`, `LayerRef`) is what makes the design small. |
| ADR-008 | **A plugin is a `Context.Service` class** with static contract, tables, migrations and a typed Layer; `Auth.make` validates the tuple pairwise. |
| ADR-009 | **Authorization is delegated to qadi.** effect-auth ships the `SubjectResolver` slot and two bridges; it defines no permissions, policies or authorizer. |
| ADR-010 | **Plugins require ports and never provide them.** Port implementations are Layers the application provides once. |
| ADR-011 | **Configuration is a service with a default** (`Context.Reference`), overridden by Layers. |
| ADR-012 | **Slots are exclusive, registries aggregate.** The type of a contribution says whether it can conflict. |

---

## 23. Roadmap

| Milestone | Deliverable |
|---|---|
| M0 Architecture | `AuthPlugin.Service`, `Auth.make` with `Validate`, core tuple, `AuthHttp`; a toy plugin compiles, a missing dependency fails to compile |
| M1 Core | `Users`, `Accounts`, `Sessions`, `Verification`, `Authentication`, CSRF, memory and SQL persistence |
| M2 Password | sign-up, sign-in, reset, verification, breach check |
| M3 qadi bridge | `SubjectResolver`, `AuthorizedSubject`, `SubjectExtractor`, `Roles` plugin, obligation handlers |
| M4 OAuth and Passkey | providers as Layers, PKCE, explicit linking; WebAuthn port |
| M5 Client and React | `AtomHttpApi` client, session atom, providers with `QadiProvider`, Next.js adapter |
| M6 Tooling | `TestAuth`, contract tests, CLI, migrations, OpenAPI |
| M7 Phase-2 plugins | two-factor, magic link, organization with relationship resolver, API keys, admin, JWT |
| M8 Stable | security review, docs for three audiences, Plugin API v1 frozen |

---

## 24. Definition of done for v1

- Architecture: `Auth.make` refuses duplicate ids, missing dependencies and slot conflicts at compile time; `Layer.launch` refuses missing ports; contract and handlers cannot diverge.
- Authentication: users, accounts, sessions, verification, password, OAuth, passkey.
- Authorization: `SubjectResolver` slot, both qadi paths, roles plugin, obligation handler, resolvers from auth data, all covered by contract tests.
- HTTP: contracts per plugin, `Authentication` and `CsrfProtection`, OpenAPI, web handler.
- Client: derived client with CSRF required by type, session atom, React providers, Next.js adapter.
- Persistence: Postgres and SQLite drivers, migrations ordered by the linker.
- Tooling: `TestAuth`, contract tests, CLI.
- Security: review, secure defaults, redaction tests, session and token abuse-case suites.

---

## 25. Open decisions

1. npm scope rename.
2. Session lifetime defaults (30d/7d per this PRD vs 7d/1d ecosystem norm).
3. Registry policy: curated with contract-test badge (proposed) vs open list.
4. Whether third parties may override core groups (proposed: no; `E_GROUP_CONFLICT`).
5. React primitive priority: `@effect/atom-react` first (proposed) vs TanStack Query adapter first.

---

## 26. North-star developer experience

```ts
export const auth = Auth.make([Password, Passkey, Organization, Roles])

export const AuthLive = auth.layer.pipe(
  Layer.provide(Password.config({ minLength: 14 })),
  Layer.provide(Roles.graph([member, admin])),
  Layer.provide(PasswordHasher.layerArgon2id),
  Layer.provide(Mailer.layerSes),
  Layer.provide(WebAuthn.layerSimpleWebAuthn({ rpId: "example.com", origins: ["https://example.com"] })),
  Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
  Layer.provide(PgMigrator.layer({ loader: PgMigrator.fromRecord(auth.migrations) }).pipe(
    Layer.provideMerge(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })))),
  Layer.provide(NodeServices.layer)
)
// Delete the Mailer line: AuthLive no longer compiles.
// Add TwoFactor to the tuple without Password: Auth.make names the missing plugin.
```

```ts
byId: ({ params }) => projects.byId(params.id).pipe(
  enforceProjected(canReadProject),                           // qadi decides and trims
  Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id: params.id }))
)
```

That is the product promise: **authentication as a typed Layer graph, extended by plugins that are services, with authorization decided by qadi, and the compiler telling you what is missing before anything runs.**
