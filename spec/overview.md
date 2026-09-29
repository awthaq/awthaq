# awthaq Overview

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-OVERVIEW |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Reworded Mission section from present-tense to planned-system phrasing, consistent with the document's own honesty banner (CCR-EA-002) |

---

> **This describes a planned system.** No package in this document has been published, no code compiles against it, and no API listed below has shipped. Every table and every signature is the surface committed to by `archive/design/plugins-as-layers.md` and the usage cookbooks (`archive/design/usage-examples-v4.md`, `archive/design/usage-qadi.md`), stated here as a target for implementation. Treat "Export" columns as names an implementation must produce, not names it currently exposes.

## Mission

awthaq is a TypeScript authentication runtime built natively on Effect v4. Its differentiator is not its feature list but its composition model: every capability is a service, every contribution is a `Layer`, and the application's dependency graph is checked by the TypeScript compiler before anything runs.

The central thesis: authentication capabilities are Effect services. Features are plugins that are themselves services. Installing a plugin is providing a Layer. Whatever the Layer still requires is what the application still has to provide, and the type checker says so — a missing plugin, a missing port implementation, a duplicate plugin id, two plugins overriding one slot, or a tap on an undefined hook point is a compile error, not a runtime surprise.

Authentication and authorization are deliberately split across two libraries by the same author. **awthaq** is designed to resolve *who is asking* — it is planned to issue sessions, verify credentials, and produce a `Principal`. **qadi** decides *what they may do and what they may see* — awthaq is planned to ship no permission model, no policy language, and no authorizer of its own; it is planned to ship exactly the bridge qadi needs (the `SubjectResolver` slot and two integration paths) and otherwise stay out of authorization entirely.

## Design philosophy

These are the principles the plugin system, the contract stratum, and the composition model are all planned to uphold. Each is a constraint the type checker or the runtime is meant to enforce, not a style preference.

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
| 2 Ports | `@awthaq/ports` | `PasswordHasher`, `Mailer`, `WebAuthn`, each with `layer`, `layerNoop`, `layerMemory` variants. |
| 3 Persistence | `@awthaq/sql` | Models, repositories, migration records, memory twins. |
| 4 Domain | `@awthaq/core` | Domain services, hook points, `AuthEvents`, config references, slots, the `Auth` namespace. |
| 5 HTTP | `@awthaq/server` | Middleware implementations, core handlers, `AuthHttp`. |
| 6 Authorization | `@awthaq/qadi` | `AuthorizedSubject` middleware, `SubjectExtractor` layer, obligation handlers — the bridge to qadi, not an authorizer. |
| 7 Composition | (application code) | `Auth.make([...])` and the application's own `Layer.provide` stack. |
| client | `@awthaq/client`, `@awthaq/react`, `@awthaq/next` | `HttpApiClient` bindings, reactive atoms, provider glue, framework adapters. Headless by design: no drop-in sign-in/sign-up/user-button/organization-switcher components, ever — apps build their own UI against typed contract errors and atoms. |
| tools | `@awthaq/test`, `@awthaq/cli` | `TestAuth`, contract tests, `doctor`, migrations, `openapi`. |
| plugins | `@awthaq/password`, `oauth`, `passkey`, `magic-link`, `two-factor`, `organization`, `roles`, `api-key`, `admin`, `jwt` | One `AuthPlugin.Service` class each. |

## Planned public API surface

Each table below is a planned surface, not a shipped one. "Source" is the intended file path per `archive/design/plugins-as-layers.md` and the strata table above.

### Composition stratum (7)

| Export | Kind | Source |
|---|---|---|
| `Auth.make` | function | `Auth.ts` |
| `Auth.api` | function (sugar over `HttpApi.addHttpApi`) | `Auth.ts` |
| `Auth.Validate<P>` | conditional type | `Auth.ts` |
| `Auth.Built<P>` | interface (`api`, `layer`, `migrations`, `manifest`) | `Auth.ts` |

### Plugin contract (stratum 4, cross-cutting)

| Export | Kind | Source |
|---|---|---|
| `AuthPlugin.Service` | class factory (`Context.Service` producer) | `AuthPlugin.ts` |
| `AuthPlugin.layer` | function | `AuthPlugin.ts` |
| `AuthPlugin.Class` | interface | `AuthPlugin.ts` |
| `AuthPlugin.Any` | interface | `AuthPlugin.ts` |

### Contract stratum (1)

| Export | Kind | Source |
|---|---|---|
| `Principal` (`UserPrincipal`, `ApiKeyPrincipal`, `ServicePrincipal`, `AnonymousPrincipal`) | `Schema.Union` of `Schema.TaggedClass` | `Principal.ts` |
| `SessionView` | `Schema.Class` (`{ principal, user, session, subject }`) | `SessionView.ts` |
| `SubjectDto` | `Schema.Class` | `SubjectDto.ts` |
| `Authentication` | `HttpApiMiddleware.Service` | `Authentication.ts` |
| `OptionalAuthentication` | `HttpApiMiddleware.Service` | `Authentication.ts` |
| `CsrfProtection` | `HttpApiMiddleware.Service` (`requiredForClient: true`) | `CsrfProtection.ts` |

### Ports stratum (2)

| Export | Kind | Source |
|---|---|---|
| `PasswordHasher` (`layerArgon2id`, `layerScrypt`, worker-pool variants in `PasswordHasherWorkerPool`) | `Context.Tag` + Layers | `PasswordHasher.ts` — plus a verify-only `LegacyPasswordVerifiers` reference for imported foreign hashes (bcrypt, Firebase scrypt, better-auth scrypt) |
| `Mailer` (`layerNoop`, `layerMemory`) | `Context.Tag` + Layers | `Mailer.ts` — `send` fails with a typed `MailDeliveryFailed` (EEM-002); `layerNoop` still dies |
| `WebAuthn` (`layerSimpleWebAuthn`) | `Context.Tag` + Layers | `WebAuthn.ts` |

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
| `BeforeSignUp`, `BeforeSignIn`, `BeforeSessionIssue`, `AfterSignUp`, `AfterSignIn`, `BeforeUserDelete` | hook points (`HookPoint.Service`) | `Hooks.ts` |

**Edge and origin.** Persistence depends only on `effect`'s `SqlClient`, so where code runs is decided by the client provided. Edge runtimes (Workers, Vercel Edge) do stateless work — verifying a signed JWT (`@awthaq/jwt`), presence checks — and need no database; origin (Node) owns everything backed by a `SqlClient` (sessions, users, credentials, migrations), unless an HTTP-capable sqlite-dialect driver (libSQL) is used. The driver matrix and its tested/untested status is in `packages/sql/README.md`, "Runtimes & drivers" (ERAS-006).

### Qadi bridge (stratum 6)

| Export | Kind | Source |
|---|---|---|
| `SubjectResolver` | slot (`Context.Reference` with fail-closed default) | `SubjectResolver.ts` |
| `AuthorizedSubject` | `HttpApiMiddleware.Service` (Path A) | `AuthorizedSubject.ts` |
| `SubjectExtractor` | `Context.Service` / Layer (Path B) | `SubjectExtractor.ts` |

## Worked example

Illustrative and planned, not runnable today — reproduced from `archive/PRD.md` §26, the product's north-star developer experience:

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
