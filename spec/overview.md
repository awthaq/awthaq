# awthaq Overview

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-OVERVIEW |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Reworded Mission section from present-tense to planned-system phrasing, consistent with the document's own honesty banner (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced the "planned system, nothing shipped" banner with the shipped state; reconciled the package map and every surface table with the exports in `packages/` (the Ports stratum lists all fifteen modules, the contract stratum its real names, the plugin roster its real packages); the Ports and core-API inventories are diffed against source by `spec/scripts/check-drift.mjs` (DTWS-001, DTWS-008, AVS-008, CCR-EA-006) |

---

> **Status: implemented, pre-1.0, unpublished.** Every package in the map below exists under `packages/` with a passing test suite, except `@awthaq/two-factor` and `@awthaq/magic-link` (placeholder packages with no exports yet) and the SAML service provider (`@awthaq/saml`, specified in [ADR-EA-023](decisions/023-enterprise-federation-packages.md) and [behaviors/29-saml-sp.md](behaviors/29-saml-sp.md), not built). No package is published to npm. The tables below list what the packages export today; a row is called out where the design commits to more than has shipped. The Ports table is bracketed by `surface:` markers because `spec/scripts/check-drift.mjs` diffs it against the source exports and fails `pnpm check` on drift, so it cannot silently rot.

## Mission

awthaq is a TypeScript authentication runtime built natively on Effect v4. Its differentiator is not its feature list but its composition model: every capability is a service, every contribution is a `Layer`, and the application's dependency graph is checked by the TypeScript compiler before anything runs.

The central thesis: authentication capabilities are Effect services. Features are plugins that are themselves services. Installing a plugin is providing a Layer. Whatever the Layer still requires is what the application still has to provide, and the type checker says so — a missing plugin, a missing port implementation, a duplicate plugin id, two plugins overriding one slot, or a tap on an undefined hook point is a compile error, not a runtime surprise.

Authentication and authorization are deliberately split across two libraries by the same author. **awthaq** resolves *who is asking* — it issues sessions, verifies credentials, and produces a `Principal`. **qadi** decides *what they may do and what they may see* — awthaq ships no permission model, no policy language, and no authorizer of its own; it ships exactly the bridge qadi needs (the `SubjectResolver` slot and two integration paths) and otherwise stays out of authorization entirely.

## Design philosophy

These are the principles the plugin system, the contract stratum, and the composition model uphold. Each is a constraint the type checker or the runtime enforces, not a style preference.

- **Capability over implementation.** A plugin depends on a port — `PasswordHasher`, `Mailer`, `WebAuthn` — never on a concrete implementation. The application chooses the implementation once, at the top of its Layer graph.
- **Plugins require ports; they never provide them.** A port implementation is a Layer the application supplies, not a plugin the ecosystem ships. This removes an entire class of plugin conflicts by construction: two plugins cannot both "provide the hasher," because providing a hasher was never a thing a plugin could do.
- **Declarative, frozen, static.** A plugin's contract, its tables, and its migrations are static class members, fixed at definition time. Only Layers see configuration; nothing about a plugin's shape depends on runtime input.
- **Configuration is a service with a default.** Options are not constructor arguments; they are a `Context.Reference` value with a default, overridden by a Layer. Per-tenant and per-test overrides need no mechanism beyond the one every other override already uses.
- **One source of truth per concept.** One contract per plugin group, one model per table, one evaluator for authorization decisions (qadi's). Nothing in this system maintains two representations of the same fact that could drift apart.
- **Typed failures with reasons.** Domain services fail with one error wrapper per domain, carrying a `reason` union, so handlers can `Effect.catchReasons` instead of pattern-matching on strings.
- **Failure is not denial; absence is refusal.** Inherited from qadi and applied to authentication too: an outage that prevents a decision is a 5xx, never a 403 or 401 dressed up as one; an endpoint that declares nothing is refused, not silently open.

## Packages

The system is organized into seven strata plus client, tooling, and plugin packages. A stratum depends only on strata below it.

| Stratum | Package | Contents |
|---|---|---|
| 1 Contract | `@awthaq/api` | `Principal`, `SessionView`, `SubjectDto`, errors, `Authentication` and `CsrfProtection` middleware definitions, core groups. Isomorphic — no server code, importable in the browser. |
| 1 Contract | `@awthaq/<plugin>/api` | Each plugin's own groups, schemas, errors, and contract `HttpApi`. |
| 2 Ports | `@awthaq/ports` | The capabilities a plugin requires and the application provides: `PasswordHasher`, `Mailer`, `WebAuthn`, `Encryption`, `KeyProvider`, `RateLimiter`, `SqlTransaction`, `ClientAddress`, `LegacySessionBridge`, `WebCrypto`, plus helpers (`Hmac`, `RefreshingCache`, `Defects`, `Tenant`, `PasswordHasherWorkerPool`). Each service ships the layers its own module documents — not a uniform `layer`/`layerNoop`/`layerMemory` triple. |
| 3 Persistence | `@awthaq/sql` | Models, repositories, migration records, memory twins. |
| 4 Domain | `@awthaq/core` | Domain services, hook points, `AuthEvents`, config references, slots, the `Auth` namespace. |
| 5 HTTP | `@awthaq/server` | Middleware implementations, core handlers, `AuthHttp`. |
| 6 Authorization | `@awthaq/qadi` | `AuthorizedSubject` middleware, `SubjectExtractor` layer, obligation handlers — the bridge to qadi, not an authorizer. |
| 7 Composition | (application code) | `Auth.make([...])` and the application's own `Layer.provide` stack. |
| client | `@awthaq/client`, `@awthaq/react`, `@awthaq/next` | `HttpApiClient` bindings, reactive atoms, provider glue, framework adapters. Headless by design: no drop-in sign-in/sign-up/user-button/organization-switcher components, ever — apps build their own UI against typed contract errors and atoms. |
| tools | `@awthaq/test`, `@awthaq/cli` | `TestAuth`, `runPluginContractTests`, the redaction guard; the `awthaq` command line (`doctor`, `config list`, `plugin list`, `routes`, `migration`, `openapi`, `seed admin`, `import`, `login`). |
| plugins | `@awthaq/password`, `oauth`, `passkey`, `jwt`, `api-key`, `organization`, `roles`, `admin`, `scim` (shipped); `magic-link`, `two-factor` (placeholders); `saml` (specified only) | One `AuthPlugin.Service` class each. |
| migration | `@awthaq/migrate-auth0`, `@awthaq/migrate-firebase`, `@awthaq/migrate-better-auth` | Verify a foreign password hash on first sign-in, or bridge a still-live foreign session, so a cutover needs no mass reset. |

## Public API surface

Each table lists what the package exports. "Source" is the file under the stratum's `packages/<name>/src/` directory.

### Composition stratum (7)

| Export | Kind | Source |
|---|---|---|
| `Auth.make` | function | `Auth.ts` |
| `Auth.Validate<P>` | conditional type | `Auth.ts` |
| `Auth.Built<P>` | interface (`api`, `publicApi`, `adminApi`, `layer`, `migrations`, `manifest`) | `Auth.ts` |

### Plugin contract (stratum 4, cross-cutting)

| Export | Kind | Source |
|---|---|---|
| `AuthPlugin.Service` | class factory (`Context.Service` producer) | `AuthPlugin.ts` |
| `AuthPlugin.layer` | function | `AuthPlugin.ts` |
| `AuthPlugin.Class` | interface (`id`, `apiVersion`, `contract`, `tables`, `migrations`, `dependsOn`, `taps`, `config`) | `AuthPlugin.ts` |
| `AuthPlugin.Any` | interface | `AuthPlugin.ts` |

### Contract stratum (1)

| Export | Kind | Source |
|---|---|---|
| `Principal` (`UserPrincipal`, `ApiKeyPrincipal`, `ServicePrincipal`, `AnonymousPrincipal`) | `Schema.Union` of `Schema.TaggedClass` | `Api.ts` |
| `SessionDto` | `Schema.Class`, the session endpoints' response | `Session.ts` |
| `SubjectDto` | `Schema.Class` (a `SessionView` combining principal, user, session and subject in one struct is specified by BEH-EA-026 but not built: the subject travels separately) | `Subject.ts` |
| `Authentication` | `HttpApiMiddleware.Service` | `Api.ts` |
| `OptionalAuthentication`, `MachineAuthentication`, `AdminAuthentication` | `HttpApiMiddleware.Service` | `Api.ts` |
| `CsrfProtection` | `HttpApiMiddleware.Service` (`requiredForClient: true`) | `Api.ts` |
| `AuthCoreApi` | core's own `session` and `account` groups, the input `Auth.make` seeds its composed `api` with | `AuthCore.ts` |

The exact core endpoint inventory is in [ADR-EA-003](decisions/003-httpapi-as-contract.md) and is diffed against `packages/api/src` by `spec/scripts/check-drift.mjs`.

### Ports stratum (2)

<!-- surface:ports -->
ClientAddress
Defects
Encryption
Hmac
KeyProvider
LegacySessionBridge
Mailer
PasswordHasher
PasswordHasherWorkerPool
RateLimiter
RefreshingCache
SqlTransaction
Tenant
WebAuthn
WebCrypto
<!-- /surface:ports -->

The block above is the module list of `packages/ports/src/index.ts`, one name per line (machine-checked). What each module provides:

| Module | Kind | Layers and notes |
|---|---|---|
| `PasswordHasher` | `Context.Service` | `layerArgon2id`, `layerScrypt`; worker-pool variants in `PasswordHasherWorkerPool`; a verify-only `LegacyPasswordVerifiers` `Context.Reference` for imported foreign hashes (bcrypt, Firebase scrypt, better-auth scrypt) |
| `Mailer` | `Context.Service` | `layerNoop`, `layerMemory`; `send` fails with a typed `MailDeliveryFailed` (EEM-002) |
| `WebAuthn` | `Context.Service` | `layerSimpleWebAuthn` |
| `Encryption` | `Context.Service` | `layer` (requires `KeyProvider` and `Crypto`); keyed envelopes, lazy re-encryption ([ADR-EA-019](decisions/019-encryption-key-rotation.md)) |
| `KeyProvider` | `Context.Service` | `layerEnv` (`AWTHAQ_ENCRYPTION_KEYS`, `AWTHAQ_ENCRYPTION_KEY_ID`); implement the port for a KMS |
| `RateLimiter` | `Context.Service` | `layer` over a `RateLimiterStore`, `layerMemory`, `layerStoreMemory`, `layerPermissive` (tests only); `RateLimiterConfig` reference |
| `SqlTransaction` | `Context.Service` | `layerSql`, `layerNoop` |
| `ClientAddress` | `Context.Service` | `layerDirect`, `layerTrustedProxy(config)` |
| `LegacySessionBridge` | `Context.Reference` | default resolves nothing; `@awthaq/migrate-better-auth` provides the real one |
| `WebCrypto` | Layer | `layer`, the `Crypto` service over `globalThis.crypto` for edge runtimes |
| `Hmac`, `RefreshingCache`, `Defects`, `Tenant` | helpers | constant-time comparison and HMAC, a single-flight TTL cache, tagged defect classes, the ambient `TenantContext` |

### Domain stratum (4)

| Export | Kind | Source |
|---|---|---|
| `Sessions` | `Context.Service` | `Sessions.ts` |
| `Users` | `Context.Service` | `Users.ts` |
| `Accounts` | `Context.Service` | `Accounts.ts` |
| `Verification` | `Context.Service` | `Verification.ts` |
| `AuthEvents` | `Context.Service` (bounded `PubSub`; in-process, at-most-once — `AuditLog` is the durable record and `EventRelay` the cross-process outbox, ADR-EA-030) | `AuthEvents.ts` |
| `EventRelay`, `EventTransport`, `RelayCursorStore` | opt-in outbox relay over the audit log, transport port, persisted position | `EventRelay.ts` |
| `Erasure`, `DataExport` | account erasure and data-subject export over aggregating registries plugins contribute to (ADR-EA-031) | `Erasure.ts`, `DataExport.ts` |
| `Retention`, `SecuritySignals` | opt-in retention sweep and breach-signal detector | `Retention.ts`, `SecuritySignals.ts` |
| `BeforeSignUp`, `BeforeSignIn`, `BeforeSessionIssue`, `AfterSignUp`, `AfterSignIn`, `BeforeUserDelete`, `AfterUserAttributesChanged` | hook points (`HookPoint.veto`/`observe`/`divert`), aggregated by the composition's `Hooks.HooksLive` ([ADR-EA-033](decisions/033-hook-registries-per-composition.md)) | `Hooks.ts` |

**Tenancy and data location.** A tenant is an `Organization` row ([ADR-EA-018](decisions/018-tenancy-is-an-organization.md)); the persistence stratum only carries an opaque, nullable `"tenantId"` on its core tables, stamped from an ambient `TenantContext` and null in every single-tenant deployment. Where data lives is whatever database the provided `SqlClient` points at; multi-region is a `LayerMap.Service` keyed by region or tenant that yields a `SqlClient` (ADR-EA-005), not per-table logic. See `packages/sql/README.md`, "Multi-tenancy" and "Data location & residency".

**Edge and origin.** Persistence depends only on `effect`'s `SqlClient`, so where code runs is decided by the client provided. Edge runtimes (Workers, Vercel Edge) do stateless work — verifying a signed JWT (`@awthaq/jwt`), presence checks — and need no database; origin (Node) owns everything backed by a `SqlClient` (sessions, users, credentials, migrations), unless an HTTP-capable sqlite-dialect driver (libSQL) is used. The driver matrix and its tested/untested status is in `packages/sql/README.md`, "Runtimes & drivers" (ERAS-006).

### Qadi bridge (stratum 6)

| Export | Kind | Source |
|---|---|---|
| `SubjectResolver` | slot (`Slots.Slot`, fail-closed default) | `SubjectResolver.ts` |
| `AuthorizedSubject`, `AuthorizedSubjectLive` | `HttpApiMiddleware.Service` and its Layer (Path A) | `AuthorizedSubject.ts` |
| `SubjectExtractorLive` | Layer (Path B: feeds qadi's declared-permission middleware) | `SubjectExtractor.ts` |
| `Resolvers`, `AttributeResolvers`, `UserClaims` | qadi attribute and relationship resolvers over awthaq data; a registry that refuses two producers of one attribute | `Resolvers.ts`, `AttributeResolvers.ts`, `UserClaims.ts` |
| `RequestDecisionCache`, `DecisionCacheInvalidation`, `DecisionLogging`, `AuthorizationAudit` | request-scoped decision cache with an opt-in invalidation bridge, decision logging and audit | (same names) |
| `SubjectApi` | the `GET /subject` group, composed by the bridge rather than by core | `SubjectApi.ts` |

## Worked example

Illustrative, not a compiled listing — reproduced from `archive/PRD.md` §26, the product's north-star developer experience. The root [`README.md`](../README.md) carries the runnable, type-checked quickstart:

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
    Layer.provideMerge(PgClient.layerConfig({
      url: Config.Redacted("DATABASE_URL"),
      maxConnections: 10,        // (server max_connections - headroom) / app instances
      idleTimeout: "30 seconds", // prepare: false behind pgbouncer transaction pooling
    })))),
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

That is the product promise: authentication as a typed Layer graph, extended by plugins that are services, with authorization decided by qadi, and the compiler telling you what is missing before anything runs.
