# awthaq Glossary

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-GLOSSARY |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added missing entries: CsrfProtection, CurrentPrincipal, CurrentSubject, Redacted, TestAuth (CCR-EA-002) |

---

> **This describes a planned system.** Every term below names a concept in a design that has not been implemented. Definitions are drawn from `archive/PRD.md` §7 and `archive/design/plugins-as-layers.md`; none describes the behavior of running code.

## Core concepts

### Principal

Who is asking. A `Schema.Union` of `Schema.TaggedClass`es — `UserPrincipal` (carrying a `sessionId` and an optional `actingAs` for impersonation), `ApiKeyPrincipal`, `ServicePrincipal`, and `AnonymousPrincipal` — each wrapping a Zanzibar-shaped `PrincipalRef { type, id }`. A Principal is awthaq's entire answer to "who"; it says nothing about what that identity may do. See: [BEH-EA-025](behaviors/04-contract-stratum.md#beh-ea-025-a-principal-is-a-tagged-union-carrying-a-zanzibar-shaped-reference).

### Subject

qadi's `AuthSubject`, derived from a Principal by the `SubjectResolver` slot: an id, roles, permissions, and attributes. A Subject is where authentication's output becomes authorization's input — the one point the two libraries touch. See: [BEH-EA-137](behaviors/18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only), [ADR-EA-009](decisions/009-authorization-delegated-to-qadi.md#adr-ea-009-authorization-is-delegated-to-qadi).

### User

A `Model.Class` entity representing a registered person or account holder, independent of any particular sign-in method. A User can have multiple Accounts (one per credential or provider) and multiple Sessions. See: [BEH-EA-041](behaviors/06-domain-users-accounts.md#beh-ea-041-a-user-is-identified-by-a-case-insensitively-unique-email).

### Account

A `Model.Class` entity linking a User to one sign-in method, keyed on `(provider, subject)` (for example, a password credential or one linked OAuth provider identity). A User cannot unlink their last remaining Account, since that would leave them with no way to authenticate. See: [BEH-EA-041](behaviors/06-domain-users-accounts.md#beh-ea-041-a-user-is-identified-by-a-case-insensitively-unique-email).

### CurrentPrincipal

The `Context.Reference` (or middleware-provided environment value) carrying the current request's resolved `Principal`, put in place by `Authentication` middleware before a handler runs. `AuthorizedSubject` (Path A) requires `CurrentPrincipal` and derives qadi's `CurrentSubject` from it — a handler is never expected to resolve a Principal itself. See: [BEH-EA-145](behaviors/19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject).

### CurrentSubject

qadi's environment value carrying the current request's `AuthSubject`, the thing qadi's own enforcement primitives (`guard`, `enforce`, `decide`, and the rest) read. In Path A, `AuthorizedSubject` middleware derives it from `CurrentPrincipal` via the `SubjectResolver` slot and puts it in every endpoint's environment in one place, so no handler resolves it by hand. See: [BEH-EA-145](behaviors/19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject).

### Session

A `Model.Class` entity representing one authenticated device or client instance. Sessions are opaque `id.secret` tokens; only `SHA-256(secret)` is stored at rest, never the secret itself. A session carries absolute and idle expiry, refreshes on a throttled sliding schedule, and is reissued (not extended) at sign-in and at privilege change. See: [BEH-EA-049](behaviors/07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair).

### VerificationToken

A `Model.Class` entity for a purpose-scoped, single-use token — email verification, password reset, and similar flows. A token is valid for one purpose only and is consumed exactly once, in the same transaction as the action it authorizes; a replay is a distinct, published event (`auth.token.replay`), not a silent failure. See: [BEH-EA-057](behaviors/08-verification-tokens.md#beh-ea-057-a-verification-token-is-scoped-to-one-purpose).

### CsrfProtection

The domain service that composes awthaq's CSRF defenses into one strategy chain, checked in the order it is declared: `Sec-Fetch-Site` first (a browser-set header page script cannot forge), falling back to comparing `Origin` against the expected host, and a signed double-submit `__Host-csrf` cookie beneath both. There is no separate ordering mechanism — the security record's declaration order *is* the strategy chain. See: [BEH-EA-073](behaviors/10-csrf.md#beh-ea-073-sec-fetch-site-is-the-primary-csrf-signal), [BEH-EA-072](behaviors/09-authentication-middleware.md#beh-ea-072-the-security-records-declaration-order-is-the-entire-strategy-chain--no-separate-ordering-mechanism-exists).

### TestAuth

The planned testing harness's entry point: `TestAuth.layer` runs the whole plugin pipeline — the same `Auth.make` composition an application uses — over an in-memory backend, so a plugin author's tests exercise the real contract and Layer graph rather than a stand-in. See: [BEH-EA-193](behaviors/25-testing-harness.md#beh-ea-193-testauthlayer-is-the-whole-pipeline-over-memory).

### Redacted

Effect's wrapper type for a value that must never reach a log line, a span, or a published event in cleartext — passwords, session secrets, and verification tokens are carried as `Redacted` throughout every domain-service and HTTP boundary; repository rows below core hold the plain value only transiently (a `Redacted` encoded form is not a bindable SQL parameter). The planned plugin contract-test harness (`runPluginContractTests`) is meant to assert mechanically that no `Redacted` value reaches a span or an event, rather than trusting that property to manual review of every plugin's logging call sites. See: [BEH-EA-199](behaviors/25-testing-harness.md#beh-ea-199-redaction-and-contract-hash-stability).

### Contract

Stratum 1: the isomorphic layer of schemas, typed errors, `HttpApiGroup`s, the merged `HttpApi`, and middleware definitions that has no server-side implementation and no database dependency. The Contract is what a client — including a browser bundle — imports; handlers, the client, OpenAPI documentation, and tests are all derived from it, never maintained as separate artifacts. See: [ADR-EA-003](decisions/003-httpapi-as-contract.md#adr-ea-003-httpapi-is-the-api-contract), [BEH-EA-025](behaviors/04-contract-stratum.md#beh-ea-025-a-principal-is-a-tagged-union-carrying-a-zanzibar-shaped-reference).

### Layer

Effect's dependency-injection and resource-construction primitive: `Layer<ROut, E, RIn>` describes what a piece of code provides (`ROut`), how it can fail while doing so (`E`), and what it still requires (`RIn`) to run. Every plugin, every port implementation, and every application composition root in awthaq is expressed as a Layer, which is why the type checker can read dependency, port, and slot information directly off `RIn`/`ROut` instead of off a separately maintained manifest. See: [ADR-EA-001](decisions/001-plugins-contribute-layers.md#adr-ea-001-plugins-contribute-effect-layers).

### Stratum

One of the seven architectural layers awthaq is organized into — Contract, Ports, Persistence, Domain, HTTP, Authorization, Composition — each depending only on strata below it. A stratum boundary is a Layer boundary: nothing in a lower stratum imports from a higher one. See: [spec/overview.md](overview.md).

## Plugin system

### Plugin

A `Context.Service` class with a static `contract` (an `HttpApi` fragment), static `tables` and `migrations`, and a typed `layer`. Application code depends on a plugin exactly as it depends on any other service (`yield* Password`); installing a plugin means providing its Layer. A plugin never provides a port — it only ever requires one. See: [BEH-EA-001](behaviors/01-plugin-contract.md#beh-ea-001-a-plugin-is-a-contextservice-class-produced-by-authpluginservice), [ADR-EA-008](decisions/008-plugin-is-context-service-class.md#adr-ea-008-a-plugin-is-a-contextservice-class).

### AuthPlugin.Service

The class factory that turns a plain interface (a plugin's shape) plus a small options object (`apiVersion`, `contract`, `tables`, `migrations`) into a fully typed `Context.Service` class carrying those statics. It is the one construction every plugin, first-party or third-party, goes through. See: [BEH-EA-001](behaviors/01-plugin-contract.md#beh-ea-001-a-plugin-is-a-contextservice-class-produced-by-authpluginservice), [ADR-EA-008](decisions/008-plugin-is-context-service-class.md#adr-ea-008-a-plugin-is-a-contextservice-class).

### apiVersion

A literal integer (currently `1`) every plugin declares as part of its static shape. A plugin built against a different Plugin API generation than `Auth.make` expects is rejected at the `Auth.make` call site, before anything else about the plugin is even considered. See: [BEH-EA-001](behaviors/01-plugin-contract.md#beh-ea-001-a-plugin-is-a-contextservice-class-produced-by-authpluginservice).

### Port

A service a plugin requires and the application — never another plugin — provides: examples include `PasswordHasher`, `Mailer`, `WebAuthn`, and the Effect-native `Crypto`, `KeyValueStore`, `RateLimiter`, `SqlClient`. Because plugins can only require ports and never provide them, two plugins cannot conflict over "who provides the hasher" — that situation cannot arise by construction. See: [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [ADR-EA-010](decisions/010-plugins-require-ports-never-provide.md#adr-ea-010-plugins-require-ports-and-never-provide-them).

### Slot

A `Context.Reference` with a fail-closed default that at most one installed plugin may override — `SubjectResolver` and `SessionViewExtension` are the two core examples. `Auth.make` rejects a tuple in which two plugins override the same slot. See: [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [ADR-EA-012](decisions/012-slots-exclusive-registries-aggregate.md#adr-ea-012-slots-are-exclusive-registries-aggregate).

### Hook point

A service holding a registry cell that other plugins may tap. A veto hook point may abort or amend the value flowing through it; an observe hook point is fail-isolated, so a failing tap cannot fail the operation it observes. Tapping a hook point nobody defines is a compile error, since the point's service type remains unsatisfied. See: [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [BEH-EA-089](behaviors/12-hooks.md#beh-ea-089-a-hook-point-is-declared-as-a-service-carrying-its-own-kind).

### Registry

An aggregating service that several plugins may contribute to concurrently, filled through `Layer.effectDiscard` writes — hook taps, event subscribers, rate-limit rules, and session claims are all registries. Unlike a slot, a registry has no exclusivity rule: contributions are ordered by dependency, then by a declared `order`, then by plugin id, and the registry freezes at first read. See: [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [ADR-EA-012](decisions/012-slots-exclusive-registries-aggregate.md#adr-ea-012-slots-are-exclusive-registries-aggregate).

### Validate<P>

A conditional type applied pairwise over the plugin tuple passed to `Auth.make`. It walks the tuple checking for duplicate ids, missing dependencies, and slot conflicts, and — when it finds one — resolves to a type whose sole property is a human-readable string naming the exact problem, so the compiler error at the `Auth.make` call site is legible rather than a wall of unresolved generic constraints. See: [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple).

### dependsOn

A plugin's declared list of other plugin classes it requires to be installed alongside it. `dependsOn` does two jobs at once: it is folded into the plugin's Layer `RIn` (so a missing dependency is also a missing-service compile error independent of `Auth.make`), and it fixes migration ordering, since dependencies must migrate before dependents. See: [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple).

### Auth.make

The single composition function applications call with a tuple of plugins. It prepends the fixed core plugin tuple, runs `Validate<P>` over the result, and returns `{ api, layer, migrations, manifest }` — the merged contract, the merged (and still-to-be-provided) Layer, ordered migrations, and a derived manifest the CLI reads. See: [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple), [ADR-EA-002](decisions/002-plugin-graph-read-off-service-graph.md#adr-ea-002-the-plugin-graph-is-read-off-the-service-graph).

### Context.Service

The Effect v4 class shape every plugin, port, domain service, and hook point is defined as: a class whose instances carry a literal `key`, and whose static side exposes the constructors (`layer`, `layerNoDeps`, and similar) that produce Layers. It is the substrate `AuthPlugin.Service` and `HookPoint.Service` build on. See: [ADR-EA-008](decisions/008-plugin-is-context-service-class.md#adr-ea-008-a-plugin-is-a-contextservice-class).

### Context.Reference

A `Context.Reference` is a Context value with a default, overridable by providing it in a Layer's `ROut`. It is the mechanism behind both configuration (a plugin's config reference has a default and is overridden per environment or tenant) and slots (a slot's reference defaults to a fail-closed behavior and is overridden by at most one plugin). See: [ADR-EA-011](decisions/011-configuration-service-with-default.md#adr-ea-011-configuration-is-a-service-with-a-default).

### HttpApi

The Effect v4 API-contract primitive (`effect/unstable/httpapi`) that a plugin's `contract` static, and the application's merged `auth.api`, are built from. An `HttpApiGroup` is one plugin's or core's named slice of that contract; `HttpApi.make(...).add(...)` composes groups into one API description that handlers, clients, and OpenAPI generation all read. See: [ADR-EA-003](decisions/003-httpapi-as-contract.md#adr-ea-003-httpapi-is-the-api-contract).

## Authorization bridge

### SubjectResolver

The core slot that turns a Principal into qadi's `AuthSubject`. Its default resolves identity only (no roles, no permissions); a plugin such as `Roles` overrides it to add roles flattened through a role DAG, or scopes to add permissions for a service principal. Exactly one override may be active at a time. See: [BEH-EA-137](behaviors/18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only), [ADR-EA-009](decisions/009-authorization-delegated-to-qadi.md#adr-ea-009-authorization-is-delegated-to-qadi).

### Path A (decide-in-handler)

The first of the two qadi integration paths: the `AuthorizedSubject` middleware puts qadi's `CurrentSubject` into the environment of every endpoint in a group, and handlers call qadi's own enforcement primitives (`guard`, `enforce`, `enforceProjected`, `filter`, `decide`) against the resource they have already loaded. Path A suits decisions that depend on the loaded resource's attributes. See: [BEH-EA-145](behaviors/19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject).

### Path B (declared-permission)

The second qadi integration path: a `SubjectExtractor` layer resolves the session from the raw request so that qadi's `RequirePermission` middleware can enforce a `requiresPermission` annotation declared directly on the endpoint. An endpoint in a Path-B group that declares neither a required permission nor an explicit public-endpoint annotation is refused, not silently allowed — absence is refusal. See: [BEH-EA-153](behaviors/20-qadi-bridge-path-b.md#beh-ea-153-subjectextractor-runs-session-resolution-on-the-raw-request).

### Obligation

A qadi concept, borrowed here rather than redefined: a condition an `Allow` decision can carry that must be discharged before the enforcing call proceeds — for example, a step-up re-authentication requirement. awthaq ships `ObligationHandlers.reauth`, which discharges a re-authentication obligation by checking session freshness against the obligation's declared maximum age. See: [BEH-EA-161](behaviors/21-qadi-resolvers-obligations.md#beh-ea-161-attributes-resolved-from-the-user-table).

### qadi

The sibling authorization library, by the same author, that awthaq delegates every permission, policy, and authorization decision to. awthaq ships no authorizer of its own; it ships the `SubjectResolver` slot and the two bridges (Path A, Path B) qadi needs to receive a Subject and enforce decisions. See: [ADR-EA-009](decisions/009-authorization-delegated-to-qadi.md#adr-ea-009-authorization-is-delegated-to-qadi).
