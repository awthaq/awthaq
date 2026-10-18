# Plan 15: One host-composition module derives the servable layer from `Auth.make`

| Property | Value |
|---|---|
| Strength | Strong (README index). This plan confirms it: one module (`TestAuth.makeLayer`) is the only complete derivation of a servable pipeline, three production-shaped copies re-derive it by hand, and the SQL copy is wrong in a way the compiler cannot see |
| Dependency category | in-process (pure `Layer` algebra over modules the repo already ships) · local-substitutable (the memory and SQL persistence bundles, `Persistence.memory` / `Persistence.sql()` and each plugin's `records.memory` / `records.sql`) |
| Wave / order | After plans 01-10 (all merged). Independent of 11-14. Lands **before 20** (in-process user agent: the example smoke tests move onto `TestAuth.app` here) and **before 24** (memory records over SQLite: this plan is the one place a memory composition is assembled). Coordinates with 16, 17 and 23, which change what `Persistence.sql()` contains, not how a host calls it |
| Fixes live bugs | `examples/sql-server` (and the README quickstart it mirrors) runs only core's migrations: a plugin that owns tables, added the way the example's own comment says, type-checks with `RIn = never` and answers **503 `StoreUnavailable` (`no such table: organization_membership`)** at runtime (reproduced, §2.4). Latent in the same copies: a plugin's declared user fields get no column and no registry (`userFieldsLayer` never provided), and a boot-time migration run has none of the CLI's ledger-drift refusal, so a plugin inserted mid-tuple is silently skipped |
| Execution tickets | `.scratch/host-composition/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check the line numbers before editing: sibling plans 16, 17, 20, 23 and 24 touch some of the same files.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. Domain terms from `spec/glossary.md`. In this plan, **composition-owned** means "derivable from the `Auth.make` result, the same for every host"; **host-owned** means "a choice only the deploying application can make" (a port implementation, a database, a secret, a policy tap).

---

## 1. Summary, goals, non-goals

### 1.1 Summary

`Auth.make` returns `api`, `layer`, `migrations`, `plugins`, `userFieldsLayer` and the rest (`packages/core/src/Auth.ts:509-563`), but nothing turns that value into something a host can serve. The host has to assemble, by hand and in the right order:

- the routes for `api` (or `publicApi` / `adminApi`) with core's `session`/`account` handlers (`AuthHttp.coreHandlers`);
- every composed plugin's `records` bundle for the chosen persistence, and every declared `hookPoints` layer;
- core's services (`Users`, `Accounts`, `Sessions`, `Verification`, `AuditLog`, `AuthEvents`, `AuditChain`, `Erasure`, `DataExport`) over `Persistence.memory` or `Persistence.sql()`;
- the composition's registries (`Hooks.HooksLive`, `RateLimits.layer`, `Slots.layer`, `Authentication.CredentialResolversLive`);
- the host middleware the groups declare (`AuthHttp.middlewareFor`) and the principal resolver;
- `built.userFieldsLayer`;
- in SQL mode, core's migrations and then `built.migrations`, before anything is built over the client.

Only `packages/test/src/TestAuth.ts` does all of it (`:155-259` the bases, `:338-403` the pipeline). `examples/memory-server/app.ts:92-232`, `examples/sql-server/app.ts:58-194` and the README quickstart (`README.md:92-229`, compiled verbatim as `packages/sql/test/fixtures/readme-quickstart.ts`) each re-derive a subset. The type system guards most of the list: a missing record store, hook point, port or middleware stays in `RIn` and the composition does not compile (verified, §2.4). It does **not** guard two items, because they are not services: the migrations (an effect someone must run) and the user-field registry (a `Context.Reference` with an empty default, `UserFields.ts:300-303`). The SQL example misses both.

This plan makes host composition **deep**: one module, `AuthHost` in `@awthaq/server`, takes the built composition plus only what the host owns (the persistence choice and its `SqlClient`, the CSRF configuration, an optional principal resolver, host services and taps, a handful of serving dials) and returns the servable layer. Its `RIn` is exactly the host-owned remainder (ports, adapters, platform HTTP services), so a missing port is a compile error at `Layer.launch` and a missing migration cannot happen: in SQL mode the module runs core's and the composition's migrations itself (`migrations: "apply"`), or refuses to build when they are pending (`migrations: "verify"`, for hosts that run `awthaq migration apply` as a deploy step). Both modes share one ledger-drift check with the CLI, which moves into core's `Migrations` module.

`TestAuth.layer` becomes `AuthHost.layer` plus the test ports and the redaction guard. The two examples and the README quickstart shrink to their host-owned lines.

### 1.2 Goals

1. **One derivation.** Every composition-owned element listed above is assembled in exactly one module (`packages/server/src/AuthHost.ts`). `TestAuth`, both examples, the README quickstart and the CLI suites' application layer call it.
2. **Type-system first.** `AuthHost.layer(built, options)`'s `RIn` is exactly the host-owned requirement set; deleting a port line is a compile error naming the port (BEH-EA-014 extended to the whole servable pipeline). `persistence` and `csrf` are required options, and in SQL mode `migrations` is required too: there is no silent default for a choice only the host can make.
3. **Migrations cannot be forgotten.** A SQL host never serves a composition whose schema is behind it: `"apply"` brings it current before any service is built over the client; `"verify"` refuses the build and names the pending migrations. Either mode refuses a drifted ledger (the CLI's BEH-EA-204 rule), from one implementation.
4. **The live bug is fixed where it lives.** `examples/sql-server` composes a table-owning plugin (`Organization`) and its smoke test proves an organization can be created over SQLite.
5. **TestAuth and production share the wiring by construction**, and a contract test fails if the harness ever re-forks it.
6. **Measured shrinkage**: `examples/memory-server/app.ts` 293 → ≤ 190 lines, `examples/sql-server/app.ts` 211 → ≤ 140, the README quickstart block 180 → ≤ 100, `TestAuth.ts`'s base and pipeline (`:124-403`, 280 lines) → ≤ 110. Two hand-built memo maps (`buildApp` in both examples) and one plan-08 exemption (`AdminTier.test.ts`'s public-tier listener) disappear.

### 1.3 Non-goals

- Changing what `Auth.make` returns or what a plugin declares. `AuthHost` only reads `Built` (`plugins`, `api`, `publicApi`, `adminApi`, `layer`, `migrations`, `userFieldsLayer`).
- Providing any **port** (ADR-EA-010). `PasswordHasher`, `Mailer`, `RateLimiter`, `ClientAddress`, `Encryption`/`KeyProvider`, `Crypto`, `HttpClient`, `WebAuthn`, `XmlSignature`, `HostResolver`, `SmsSender` stay in `RIn`. So do the platform HTTP services (`HttpRouter`, `HttpPlatform`, `Etag`, `FileSystem`, `Path`): `HttpRouter.serve`/`toWebHandler` and `NodeHttpServer.layer` supply them.
- Host-owned server middleware and jobs: `SecurityHeaders.layer`, `AuthHttp.cors`, `AuthHttp.layerRedactedHeaders`, `AuthHttp.tracer`/`requestLogger`, `Retention.layerScheduled`, `SecuritySignals.layer`, `AuthorizationAudit.auditAuthorizationAnnotations`, the SQL rate-limiter store and its own migration ledger (`RateLimiterStoreSql.migrate`). They stay beside `AuthHost.layer` in the host's code.
- The middleware-under-test exemptions of plan 08 (`server/test/{Authentication,Csrf,Cors,CredentialResolvers,AuthHttp}.test.ts`, `AuthenticationWorld`, `CsrfWorld`, `ContractStratumWorld`, `SessionServer`, the CLI `TestServer`, `QadiBridgeWorld`). Their wiring is what they test.
- Snapshot diffing, checksums and destructive-change lint (BEH-EA-039's deferred CLI feature). Only the existing key-level drift check is shared.
- The `regclass` re-run problem `packages/sql/README.md:64` describes. It did not reproduce (§2.6); this plan does not depend on it either way.

---

## 2. Verified current state

### 2.1 The one complete derivation: `TestAuth.ts`

`packages/test/src/TestAuth.ts` (1,371 lines):

| Element | Where | What |
|---|---|---|
| Test hasher | `:130-139` | argon2id at the minimum cost |
| `memoryFoundation` (exported) | `:155-166` | `AuthEvents` over `AuditLog` over `Persistence.memory`, `Hooks.HooksLive`, `AuditChain.layer`, `NodeCrypto.layer` |
| `SqlStores`, `sqlFoundation` | `:169-177` | the same over `Persistence.sql()` with the test `Encryption` |
| `testPorts` | `:186-200` | hasher, `Mailer.layerMemory`, permissive/enforcing `RateLimiter`, **`RateLimits.layer`, `Slots.layer`, `Authentication.CredentialResolversLive`** (three composition-owned registries filed as "ports"), `ClientAddress.layerDirect`, `TestEncryption.layer` |
| `coreServices` | `:203-210` | `Users`, `Accounts`, `Sessions`, `Verification` |
| `memoryBase` | `:219-228` | `Erasure.layer`, `DataExport.layer` over the above and `SqlTransaction.layerNoop` |
| `sqlBase` | `:236-259` | core migrations then `Migrations.run(built.migrations)` inside `Ready` (`:241-249`), so nothing is built over the client before the schema exists |
| `GuardLive` | `:261` | `RedactionGuard` tracer/logger and its `AuthEvents` inspector |
| `makeLayer` | `:338-403` | records selection (`:343-348`), hook points (`:349-352`), `CsrfConfig` (`:355`), `middlewareFor` (`:356-361`), routes + docs (`:368-372`), `coreHandlers` with `RequestContext.warnWhenAbsent = false` (`:375-379`), then `built.layer`, `services`, middleware, resolver, csrf, taps over points, records, `decorate`, guard, base, `HttpServer.layerServices`, `HttpRouter.layer`, `built.userFieldsLayer` (`:382-401`) |
| Overloads | `:430-481` | the precise `ROut`/`RIn` formula (`Provided`, `:322-332`) |
| Contract `build` check | `:1199-1204` | calls `makeLayer` for both record modes |

### 2.2 Every hand-written copy

`grep -rln 'AuthHttp.routes(\|coreHandlers' --include='*.ts' --include='*.md'` over `packages examples features README.md docs`, excluding `lib/`, `node_modules/`, the `@awthaq/server` sources and the plan-08 middleware exemptions:

| # | Copy | Lines | Kind | Status |
|---|---|---|---|---|
| C1 | `examples/memory-server/app.ts:92-232` | ~140 (base `:102-145`, records `:147-153`, pipeline `:172-190`, memo-map `buildApp` `:209-232`) | production example | complete today |
| C2 | `examples/sql-server/app.ts:58-194` | ~137 (migrations `:76-80`, core `:101-114`, middleware/services `:127-134`, routes/docs `:136-149`, pipeline `:151-172`, `buildApp` `:176-194`) | production example | **incomplete** (§2.3) |
| C3 | `README.md:92-229` and `packages/sql/test/fixtures/readme-quickstart.ts` (178 lines, verbatim; `packages/sql/test/ReadmeQuickstart.test.ts` asserts equality) | ~138 | the documented quickstart | **incomplete**, and still builds `AuthenticationLive`/`CsrfProtectionLive` by hand (`README.md:134-136`, `:169-172`): it predates `middlewareFor` |
| C4 | `packages/admin/test/AdminTier.test.ts:77-127` | 50 | plan-08 exemption ("which API tier a listener serves is the wiring under test") | hand-wired because `TestAuth.layer` cannot serve `publicApi` |
| C5 | `packages/cli/test/support/SqlApp.ts:32-115` | 84 | the CLI's `app` (`defineConfig({ app })`, `packages/cli/src/Config.ts:62-66`) for `seed admin`/`import` | services only; its own `migrate` (`:111-115`) |
| C6 | `packages/cli/README.md:41-50` | doc | `app: AppLive, // auth.layer with every port and the SQL client provided` | tells the reader to hand-compose |
| C7 | `packages/next/README.md:250-257` | doc | `AppRoutesLayer` "AuthHttp.routes(AppApi, ...) plus your services" | consumer of a servable layer; no recipe |
| C8 | `spec/overview.md:186-205` | doc | the PRD's illustrative north-star (`auth.layer.pipe(Layer.provide(...))`) | illustrative, pre-everything |
| C9 | `docs/plugin-authoring.md:211` | doc | "Declaring [hook points] does not make `Auth.make` provide them in production (the host still builds the one point instance its taps register into)" | describes the hand-wired host |

Not copies (checked): `examples/plugin-template` (a plugin; its tests use `TestAuth`), `examples/prototype-devtools/index.html` (a throwaway static HTML prototype with fake data), `packages/cli/test/support/TestServer.ts` (a socket server over `AuthCore.AuthCoreApi`, not an `Auth.make` composition; plan-08 exemption), `packages/saml/test/Sso.test.ts`, `packages/web/test/CookieJar.test.ts`, `features/step-definitions/PersistenceStratumSteps.ts:233` (bespoke `HttpApi`s, not `Auth.make`).

### 2.3 What each production copy wires

| Element | TestAuth | C1 memory-server | C2 sql-server | C3 README |
|---|---|---|---|---|
| routes + `coreHandlers` | yes | yes (`:176-177`) | yes (`:141-143`) | yes (`:187-189`) |
| derived host middleware | `middlewareFor` | `middlewareFor` (`:184`) | `middlewareFor` (`:131`) | **by hand** (`:134-136`, `:169-172`) |
| plugin `records` bundles | selected from `built.plugins` | **listed by hand** (`:149-153`) | none (Password has none) | none |
| plugin `hookPoints` | selected | listed by hand (`:152`) | none | none |
| `Hooks.HooksLive` | yes | yes (`:107`) | yes (`:158`) | yes (`:200`) |
| `RateLimits.layer` | yes | yes (`:122`) | yes (`:164`) | yes (`:206`) |
| `Slots.layer` | yes | yes (`:125`, for the guard) | no: not a gap, `Auth.make` provides its own (`Auth.ts:534-538`) | no (same) |
| `CredentialResolversLive` | yes | yes (`:127`) | no | no |
| core migrations | yes | n/a | yes (`:78-80`) | yes (`:104-106`) |
| **`built.migrations`** | yes (`:247`) | n/a | **no** | **no** |
| **`built.userFieldsLayer`** | yes (`:401`) | yes (`:189`) | **no** | **no** |
| `RequestContext.layer` | off on purpose (`:373-379`) | in `serverLayer` only (`:255`) | in `serverLayer` (`:199`) | no |
| `BodyLimit.layer` | no | in `serverLayer` (`:254`) | in `serverLayer` (`:199`) | yes (`:224`) |

`Auth.Built` has no selector for the records or hook points. Since plan 08 it carries `plugins` (`Auth.ts:519`), which `TestAuth.makeLayer:343-352` reduces over; C1 lists the same layers by name instead.

### 2.4 The live bug, reproduced

Script (scratch only, not committed): C2's composition verbatim, with `Organization.Organization` added to `Auth.make` the way C2's comment says (`app.ts:59-60`, "Add more ... by listing them here and providing the ports and migrations each adds"), its `records.sql` and `hookPoints` merged in, `Encryption` merged beneath it, SQLite `:memory:`, a session minted with `TestAuth.signInAs`, then `POST /organization` with the CSRF pair.

- **Types.** A throwaway probe printed the composition's remaining `RIn`: **`never`**. Two controls confirm the probe is live: dropping `records.sql` leaves the six `awthaq/organization/records/*` keys in `RIn` (ConnectionRecords is not required, as plan 08 recorded); dropping `Encryption` leaves `awthaq/ports/Encryption`. So the compiler catches every omission except the migrations.
- **Runtime.** `POST /organization -> 503 {"_tag":"StoreUnavailable","operation":"MembershipRecords.listByUser"}`, caused by `SqlError: no such table: organization_membership`.
- **Control.** The same script with `Migrations.run(auth.migrations)` after the core migrator answers `200` with the new organization.

C3 has the same shape (`README.md:104-106` runs only `CoreMigrations.coreMigrations`) and the same comment (`README.md:95-97`, "once you provide the ports and migrations each one adds"). `README.md:298` sends the reader to "each plugin's own package for its migrations", where no runner exists either.

### 2.5 Latent bugs in the same copies

1. **User fields.** `Built.userFieldsLayer` is `Layer.Layer<never>` (`Auth.ts:562`): it provides a `Context.Reference` whose default is an empty map (`UserFields.ts:300-303`). A host that omits it compiles, and every declared field answers `UnknownUserField` (422) on `PATCH /user`. Over SQL the column never exists either, because the per-field migrations are part of `built.migrations` (`Auth.ts:540-543`, ADR-EA-035 decision 2), which C2/C3 never run. No shipped plugin declares a field today (`grep -rn 'userFields:' packages/*/src` outside core finds none), so this is latent: the first third-party plugin with a field hits it.
2. **Boot-time migrations have no drift guard.** `Migrator` skips any id at or below the newest recorded one (`packages/core/src/Migrations.ts:23-40`). The CLI refuses such a ledger (`packages/cli/src/Migration.ts:65-148`, `diff`/`inspect`; `apply` refuses at `:216-219`; BEH-EA-204). `TestAuth.sqlBase` (`:241-249`) and any host that copies it call `Migrator`/`Migrations.run` directly, so a plugin inserted mid-tuple on an already-migrated database is skipped without an error and its tables never appear: the §2.4 failure again, a deploy later.
3. **`CredentialResolversLive`.** C2/C3 omit it. That is not live: a contributing plugin requires the registry (`Authentication.ts:260`, `Effect.flatMap(CredentialResolvers, ...)`), so adding `ApiKey` is a compile error. It is one more line a reader must discover.

### 2.6 Claims from the candidate description, checked

| Claim | Verdict |
|---|---|
| `TestAuth.ts` `makeLayer` ~186-228 and ~338-403 is the only module that derives a servable pipeline | **True.** `:186-259` are the bases (`testPorts`, `coreServices`, `memoryBase`, `sqlBase`), `:338-403` the pipeline |
| memory-server ~102-190, ~90 lines, lists records/points by hand at ~149-153 | **True** (`:102-190`; records at `:149-153`) |
| sql-server ~55-172, runs only core migrations | **True** (`:58-172`; `:76-80`) |
| sql-server never provides `userFieldsLayer` | **True** (no `userFieldsLayer` in the file) |
| sql-server never provides `CredentialResolversLive` | **True, but not a live gap** (§2.5.3) |
| sql-server never provides `Slots.layer` | **True, and not a gap**: `Built.layer` provides the composition's own `SlotsRegistry` (`Auth.ts:534-538`). A host needs `Slots.layer` only for a layer it builds *outside* `built.layer` that overrides a slot (memory-server's guard over `Roles.layer`, `app.ts:123-125`) |
| `Auth.Built` has no records/hookPoints selector | **True**; `plugins` exists since plan 08 (`Auth.ts:519`) |
| `packages/sql/README.md:64`: a second `Migrator` run on Postgres fails without a `regclass` codec | **Not reproduced.** Against `postgres:16` with rc.116, `PgClient.layer({ url })` and no codec, three consecutive boots (core migrator, then `Migrations.run` of `Auth.make([Organization]).migrations`, on one client per boot) all succeeded. Plan 16 rewrites that README; it should re-test or drop the note (§8) |

### 2.7 Facts the design rests on (verified)

- **What a derived host composition leaves to the host.** A throwaway type probe built the pipeline of §3.3 for `Auth.make([Password, Organization])` over `Persistence.memory`, with routes, `RequestContext.layer` and `BodyLimit.layer`. Its `RIn` is exactly `ClientAddress | Encryption | Mailer | PasswordHasher | RateLimiter | Crypto | HttpClient | HttpRouter | Etag.Generator | HttpPlatform | FileSystem | Path`: the ports, the breach-check transport and the platform HTTP services. Nothing composition-owned leaks.
- **Layers are memoized by reference within one build.** `Slots.layer`, `Hooks.HooksLive`, `Authentication.PrincipalResolverLive` and `Csrf.layerConfig` are module constants, so a host layer that provides one again (memory-server's guard builds `Roles.layer` over `Slots.layer`, `app.ts:85-90`) shares the composition's instance. `middlewareFor` wraps its own layers in `Layer.fresh` (`AuthHttp.ts:175-179`) for the opposite reason.
- **Plugin layers require host middleware**, because plugin handlers live inside the plugin layer (plan 08 §2.4). Serving `publicApi` therefore narrows the routes only; the middleware is always derived from `built.api`.
- **`HttpRouter.serve`/`toWebHandler` provide the router.** `toHttpEffect` builds `Layer.provideMerge(appLayer, HttpRouter.layer)` (`effect/src/unstable/http/HttpRouter.ts:601`), so the servable layer must *require* `HttpRouter`, not provide it, or a host could not merge its own routes onto the same router.
- **The plugin migration ledger and the core ledger are two id spaces** (`Migrations.ts:23-41`, `packages/sql/README.md:117`). Core first, then plugins.
- **BEH-EA-039** (`spec/behaviors/05-persistence-stratum.md:143-155`) says a live-database drift check "MUST live in the CLI". Sharing the key-level check with `AuthHost` revises that sentence (§6).
- **`RequestContext.layer` is opt-in** (plan 01 decision 7); `coreHandlers` warns at build when the router lacks it (`AuthHttp.ts:95-106`). It needs `Crypto` and `HttpRouter`, and reads `ClientAddress` optionally (`RequestContext.ts:60-78`).
- **`@awthaq/server` already depends on `@awthaq/core`**, and core on `@awthaq/sql` (`package.json` of each). `AuthHost` needs nothing new at runtime. Its own SQL tests need `@effect/sql-sqlite-node` as a devDependency. `@awthaq/server` sits below `@awthaq/test`, so `AuthHost`'s tests cannot use the harness (plan 08's follow-up note).
- `Migrations.ts:43-67` still says `run` "has no PRODUCTION call site". The CLI's `apply` calls it (`Migration.ts:241`). The comment is stale.

---

## 3. Target design

### 3.1 The seam: composition-owned versus host-owned

| Composition-owned: `AuthHost` derives it, a host never writes it | Host-owned: an option, or left in `RIn` |
|---|---|
| routes for `api` / `publicApi` / `adminApi` (`tier`), `AuthHttp.coreHandlers`, OpenAPI/Scalar when a path is given | **`persistence`** (required): `memory`, or `sql` with its `SqlClient` layer, `migrations: "apply" \| "verify"` (required) and `Persistence.SqlOptions` |
| `built.layer` | **`csrf`** (required): `Csrf.layerConfig` or an explicit `CsrfConfig` |
| each plugin's `records[mode]`, each plugin's `hookPoints` | `principalResolver` (default `PrincipalResolverLive`) |
| core services over `Persistence[mode]`: `Users`, `Accounts`, `Sessions`, `Verification`, `AuditLog`, `AuthEvents`, `AuditChain`, `Erasure.layer`, `DataExport.layer` | `services`: plugin configuration, extra-group handlers, a guard built over a plugin layer, adapters (`SamlMetadataFetcher`, `WebhookTransport`), deliberate gates (`TwoFactor.sessionGate`), `OrganizationConnections.layerStore` for `Sso` |
| registries: `Hooks.HooksLive` (core points, erasure/export/retention registries), `RateLimits.layer`, `Slots.layer`, `Authentication.CredentialResolversLive` | `taps`: application taps (`Hooks.BeforeSignUp.tap(...)`) |
| `AuthHttp.middlewareFor(built.api, ...)` and the resolver | `decorate`: wrap a composition-owned service in place (instrumentation, fault injection) |
| `built.userFieldsLayer` | ports in `RIn`: `Crypto`, `PasswordHasher`, `Mailer`, `RateLimiter`, `ClientAddress`, `Encryption`, `HttpClient`, `WebAuthn`, `XmlSignature`, ... |
| SQL: core migrations then `built.migrations`, with the ledger-drift refusal | platform in `RIn`: `HttpRouter`, `HttpPlatform`, `Etag.Generator`, `FileSystem`, `Path` |
| `RequestContext.layer` and `BodyLimit.layer` (dials `requestContext`, `bodyLimit`, default on) | host-owned middleware and jobs beside the layer: `SecurityHeaders`, `cors`, `layerRedactedHeaders`, `Retention.layerScheduled`, `SecuritySignals.layer` |

The rule behind the left column: an element is composition-owned when it is a pure function of the plugin tuple, or a registry the composition must hold exactly once (ADR-EA-033's "registries belong to the composition"). The rule behind the right column is ADR-EA-010: a port is the application's decision and only ever appears in `RIn`.

### 3.2 The interface (`packages/server/src/AuthHost.ts`)

```ts
// @awthaq/server — AuthHost
//
// ADR-EA-044: the servable layer, derived from what `Auth.make` returned. A host provides only what it owns: where
// state lives, the CSRF secret, its ports, its own policy layers. Everything that is a function of the plugin tuple
// (routes, core handlers, records bundles, hook points, core services, registries, middleware, user fields,
// migrations) is assembled here, once. `RIn` is exactly the host-owned remainder, so `Layer.launch` refuses to
// compile while a port is missing (BEH-EA-014).

import {
  Accounts, AuditChain, AuditLog, type Auth, AuthEvents, type AuthPlugin, DataExport, Erasure, Hooks,
  Migrations, Persistence, RateLimits, Sessions, Slots, Users, Verification,
} from "@awthaq/core";
import * as Layer from "effect/Layer";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Etag from "effect/unstable/http/Etag";
import type * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import type * as HttpRouter from "effect/unstable/http/HttpRouter";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuthHttp from "./AuthHttp.ts";
import * as Authentication from "./Authentication.ts";
import * as BodyLimit from "./BodyLimit.ts";
import type * as Csrf from "./Csrf.ts";
import * as RequestContext from "./RequestContext.ts";

/** Single-process state: every core store and every plugin's `records.memory` (TRBS-005). */
export interface MemoryPersistence {
  readonly records: "memory";
}

/** One database for everything: `Persistence.sql(options)`, every plugin's `records.sql`, the migrations. */
export interface SqlPersistence<CE, CR> {
  readonly records: "sql";
  /** The one client. It is also in the output (the CLI's `import` keeps its checkpoint beside the users it writes). */
  readonly client: Layer.Layer<SqlClient.SqlClient, CE, CR>;
  /**
   * BEH-EA-H2. `"apply"`: core's migrations, then the composition's (`built.migrations`, user-field columns
   * included), run when the layer is built and before anything else is built over the client. `"verify"`: nothing
   * is applied, and a pending migration refuses the build (`Migrations/Pending`), for a host whose deploy step is
   * `awthaq migration apply`. Either way a ledger that disagrees with the linker refuses the build
   * (`Migrations/LedgerDrift`). No default: which process migrates is the host's decision.
   */
  readonly migrations: Migrations.OnBuild;
  readonly options?: Persistence.SqlOptions;
}

export interface Options<S, SE, SR, T, D, DR, CE, CR, PR> {
  /** Required. `Csrf.layerConfig` reads `AWTHAQ_CSRF_SECRET`; there is no safe default secret. */
  readonly csrf: Layer.Layer<Csrf.CsrfConfig, CE, CR>;
  /** Defaults to `Authentication.PrincipalResolverLive`; `PrincipalResolverWithUserFactsLive` adds `emailVerified`. */
  readonly principalResolver?: Layer.Layer<Authentication.PrincipalResolver, never, PR>;
  /**
   * Host-owned layers that may read the composition and that the plugins read: plugin configuration
   * (`Password.config(...)`), extra-group handlers (`SubjectApi.SubjectHandlers`), a guard built over a plugin layer,
   * adapters and gates. Built above the core services, records and middleware, beneath the plugins; merged into the
   * output, so `yield*` returns the instance the plugins used.
   */
  readonly services?: Layer.Layer<S, SE, SR>;
  /** Application taps, built over the one instance of every point (core's and each plugin's `hookPoints`). */
  readonly taps?: Layer.Layer<never, never, T>;
  /** Wraps a composition-owned service in place (a metrics `Sessions`, a fault): built over it, shadows it above. */
  readonly decorate?: Layer.Layer<D, never, DR>;
  /** AR-003: the groups this listener serves. Default `"all"`. Plugin layers are always built whole. */
  readonly tier?: "all" | "public" | "admin";
  /** `RequestContext.layer` (default `true`). `false` also silences `coreHandlers`' build-time warning. */
  readonly requestContext?: boolean;
  /** `BodyLimit.layer` (default `true`; `BodyLimit.config({ maxBytes })` tunes it). */
  readonly bodyLimit?: boolean;
  /** BEH-EA-084: serve the OpenAPI document / the Scalar page at these paths (both unauthenticated; off by default). */
  readonly openapiPath?: `/${string}` | undefined;
  readonly docsPath?: `/${string}` | undefined;
}
```

The types, in the style of `TestAuth.layer`'s overloads (`TestAuth.ts:322-332`, `:430-475`):

```ts
type Mode = "memory" | "sql";

/** The platform services `AuthHttp.routes`/`docs` need, which `HttpRouter.serve`/`toWebHandler` and the platform supply. */
export type Serving = HttpRouter.HttpRouter | HttpPlatform.HttpPlatform | Etag.Generator | FileSystem.FileSystem | Path.Path;

type BaseOut<M extends Mode> = M extends "memory"
  ? Layer.Success<typeof memoryBase>
  : Layer.Success<ReturnType<typeof sqlBase<never, never>>>;
type BaseIn<M extends Mode> = M extends "memory"
  ? Layer.Services<typeof memoryBase>
  : Layer.Services<ReturnType<typeof sqlBase<never, never>>>;

/** Everything the layer provides beneath its plugins (and merges into its output). */
export type Provided<P extends ReadonlyArray<AuthPlugin.Any>, M extends Mode, S, D> =
  | BaseOut<M>
  | Csrf.CsrfConfig
  | Authentication.PrincipalResolver
  | AuthPlugin.RecordsOut<P[number]>
  | AuthPlugin.HookPointsOut<P[number]>
  | S
  | D;

/** BEH-EA-H1: what the host still owns. `never` exactly when every port, adapter and platform service is provided. */
export type Requires<P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint, M extends Mode,
  S, SR, T, D, DR, CR, PR, KR> = Exclude<
  | Layer.Services<Auth.Built<P, Extra>["layer"]>
  | Layer.Services<typeof AuthHttp.coreHandlers>
  | Layer.Services<typeof RequestContext.layer>
  | Layer.Services<typeof BodyLimit.layer>
  | AuthPlugin.RecordsIn<P[number], M>
  | BaseIn<M>
  | Serving
  | SR | T | DR | CR | PR | KR,
  Provided<P, M, S, D> | AuthHttp.DeclaredMiddleware<Auth.AllGroups<P, Extra>>
>;

export function layer<P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint,
  S = never, SE = never, SR = never, T = never, D = never, DR = never, CE = never, CR = never, PR = never>(
  built: Auth.Built<P, Extra>,
  options: Options<S, SE, SR, T, D, DR, CE, CR, PR> & { readonly persistence: MemoryPersistence },
): Layer.Layer<
  Provided<P, "memory", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  Layer.Error<Auth.Built<P, Extra>["layer"]> | SE | CE,
  Requires<P, Extra, "memory", S, SR, T, D, DR, CR, PR, never>
>;
export function layer<P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint,
  S = never, SE = never, SR = never, T = never, D = never, DR = never, CE = never, CR = never, PR = never,
  KE = never, KR = never>(
  built: Auth.Built<P, Extra>,
  options: Options<S, SE, SR, T, D, DR, CE, CR, PR> & { readonly persistence: SqlPersistence<KE, KR> },
): Layer.Layer<
  Provided<P, "sql", S, D> | SqlClient.SqlClient | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  Layer.Error<Auth.Built<P, Extra>["layer"]> | SE | CE | KE | Migrations.OnBuildError,
  Requires<P, Extra, "sql", S, SR, T, D, DR, CR, PR, KR>
>;
export function layer(
  built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>,
  options: AnyOptions,
): Layer.Layer<never, unknown, unknown> {
  return makeLayer(built, options);
}
```

Notes for the executor:

- **No `as` anywhere, no return-type annotation on a Layer const.** The overload signatures are function declarations, the precedent `TestAuth.layer` and `AuthHttp.middlewareFor` set: the precise formula cannot be checked against an abstract `P` inside the body, so the implementation is checked against a widened signature.
- `typeof sqlBase<never, never>` is an instantiation expression (TS ≥ 4.7). If it does not infer, declare `type SqlBase = ReturnType<typeof sqlBaseOf>` over a non-generic helper that takes the client layer as `Layer.Layer<SqlClient.SqlClient>`.
- `taps` keeps its requirement `T` (`TestAuth` erased it to `unknown`, `TestAuth.ts:294`), so a tap on a point no composed plugin declares stays in `RIn` and fails to compile (INV-EA-005, now also through `AuthHost`).
- `Serving` is spelled out because `AuthHttp.routes` is generic over the api. The Phase 2 type test pins it against the probe result in §2.7; if the effect version changes what `HttpApiBuilder.layer` needs, the test fails and the union is corrected, never asserted.
- `Options` with nine type parameters follows `TestAuth.CommonOptions` (five today). Each parameter is inferred from one option; none is ever written at a call site.
- In the widened implementation (§3.3) the tier ternary yields a union of three `HttpApi` types. If `AuthHttp.routes` (a re-export of the generic `HttpApiBuilder.layer`) does not accept the union, select the routes layer instead of the api: `const routesFor = (api) => AuthHttp.routes(api, ...)` called in each branch, the same three-way choice one level up. Never widen with an assertion.

### 3.3 One implementation

```ts
/** Everything the core services read: events over the audit log, every core point and registry, the audit chain. */
const foundation = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layer),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(AuditChain.layer),
);

/** The registries a composition holds exactly once (ADR-EA-033, ADR-EA-012, MA-005). */
const registries = Layer.mergeAll(RateLimits.layer, Slots.layer, Authentication.CredentialResolversLive);

const coreServices = Layer.mergeAll(Users.layer, Accounts.layer, Sessions.layer, Verification.layer);

/** The base over one store bundle (ADR-EA-041 decision 4: the bundle brings its own `SqlTransaction`). */
const baseOver = <O, E, R>(stores: Layer.Layer<O, E, R>) =>
  Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(coreServices, registries)),
    Layer.provideMerge(foundation),
    Layer.provideMerge(stores),
  );

const memoryBase = baseOver(Persistence.memory);

/**
 * The client reaches the stores, every plugin's `records.sql` and everything above only through `Ready`, so nothing is
 * built over it before the schema is current (or verified current). The pattern of `TestAuth.sqlBase` (`:241-249`).
 */
const sqlBase = <KE, KR>(persistence: SqlPersistence<KE, KR>, migrations: Migrations.Migrations) =>
  baseOver(Persistence.sql(persistence.options)).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(Migrations.onBuild(persistence.migrations, migrations)).pipe(
        Layer.provideMerge(persistence.client),
      ),
    ),
  );

const makeLayer = (
  built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>,
  options: AnyOptions,
) => {
  const sql = options.persistence.records === "sql" ? options.persistence : undefined;
  // Plan 08's selection, moved here from `TestAuth.makeLayer:343-352`.
  const records = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>((acc, plugin) => {
    const bundle = sql === undefined ? plugin.records?.memory : plugin.records?.sql;
    return bundle === undefined ? acc : Layer.merge(acc, bundle);
  }, Layer.empty);
  const points = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>(
    (acc, plugin) => (plugin.hookPoints === undefined ? acc : Layer.merge(acc, plugin.hookPoints)),
    Layer.empty,
  );
  const resolver = options.principalResolver ?? Authentication.PrincipalResolverLive;
  // Derived from the whole api: the plugin layers (which hold every handler) need it whatever the tier serves.
  const middleware = AuthHttp.middlewareFor(built.api, { csrf: options.csrf, principalResolver: resolver });
  const api =
    options.tier === "public" ? built.publicApi : options.tier === "admin" ? built.adminApi : built.api;
  const docs = options.docsPath === undefined ? Layer.empty : AuthHttp.docs(api, { path: options.docsPath });
  const edge = Layer.mergeAll(
    options.requestContext === false ? Layer.empty : RequestContext.layer,
    options.bodyLimit === false ? Layer.empty : BodyLimit.layer,
  );
  const handlers =
    options.requestContext === false
      ? AuthHttp.coreHandlers.pipe(Layer.provide(Layer.succeed(RequestContext.warnWhenAbsent, false)))
      : AuthHttp.coreHandlers;
  return Layer.mergeAll(AuthHttp.routes(api, { openapiPath: options.openapiPath }), docs, edge).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(built.layer),
    Layer.provideMerge(options.services ?? Layer.empty),
    Layer.provide(middleware),
    Layer.provideMerge(resolver),
    Layer.provideMerge(options.csrf),
    Layer.provideMerge((options.taps ?? Layer.empty).pipe(Layer.provideMerge(points))),
    Layer.provideMerge(records),
    Layer.provideMerge(options.decorate ?? Layer.empty),
    Layer.provideMerge(sql === undefined ? memoryBase : sqlBase(sql, built.migrations)),
    // SAM-004: the composition's declared user fields, last, so `Users` and the account handler both see it.
    Layer.provideMerge(built.userFieldsLayer),
  );
};
```

The stack order is `TestAuth.makeLayer`'s (`:372-401`) with three changes: the test ports, the guard and the HTTP platform leave (they become `TestAuth`'s own, §3.5); `RequestContext.layer` and `BodyLimit.layer` join behind dials; the three registries move from `testPorts` into the base, where they always belonged. `services` keeps plan 08's measured semantics: it shadows a base service for the plugins, and for a key both provide the base instance is the one in the output (plan 08 "Plan errors found during Phase 3"). The docs comment on `services` says so.

### 3.4 One migration runner (`packages/core/src/Migrations.ts`)

The CLI's ledger inspection (`packages/cli/src/Migration.ts:36-148`) moves into core, beside `run`. Core already depends on `@awthaq/sql` (`CoreMigrations`), so no package edge is added.

```ts
// added to packages/core/src/Migrations.ts (sketch)
import { CoreMigrations } from "@awthaq/sql";
import * as Data from "effect/Data";

export const coreMigrationsTable = "effect_sql_migrations";

export interface Entry { readonly id: number; readonly name: string }
export type LedgerName = "core" | "plugins";
/** Moved from `cli/src/Migration.ts:48-57`, unchanged. */
export interface LedgerReport {
  readonly ledger: LedgerName;
  readonly table: string;
  readonly applied: ReadonlyArray<Entry>;
  readonly pending: ReadonlyArray<Entry>;
  readonly unknown: ReadonlyArray<Entry>;
  readonly outOfOrder: ReadonlyArray<Entry>;
}
export interface Status { readonly ledgers: ReadonlyArray<LedgerReport>; readonly drift: boolean }

/** A ledger holds an id the linker does not produce, or a pending id sorts before an applied one (BEH-EA-204). */
export class LedgerDrift extends Data.TaggedError("Migrations/LedgerDrift")<{
  readonly message: string;
  readonly status: Status;
}> {}
/** `verify`: the schema is behind the composition. `message` names every pending entry, ledger first. */
export class Pending extends Data.TaggedError("Migrations/Pending")<{
  readonly message: string;
  readonly status: Status;
}> {}
/** A batch failed and rolled back; `ledger` says which (core's batch may already be applied when plugins' fails). */
export class MigrationFailed extends Data.TaggedError("Migrations/MigrationFailed")<{
  readonly message: string;
  readonly ledger: LedgerName;
  readonly cause: unknown;
}> {}

export type OnBuild = "apply" | "verify";
export type OnBuildError = LedgerDrift | Pending | MigrationFailed | SqlError;

export const diff = /* moved from cli/src/Migration.ts:65-83, unchanged */;
export const tableExists = /* moved from :92-106; fails SqlError instead of the CLI's DatabaseUnavailable */;

/** Read-only: both ledgers against the linker's record. Never creates a ledger table. */
export const status = (plugins: Migrations) => /* moved from `inspect`, :134-148, over `plugins` instead of a LoadedAuth */;

/** Refuses on drift; applies core's pending batch, then the plugins'. A no-op (no `Migrator` call) when nothing is pending. */
export const apply = Effect.fnUntraced(function* (plugins: Migrations) {
  const before = yield* status(plugins);
  if (before.drift) return yield* new LedgerDrift({ message: driftMessage(before), status: before });
  if (before.ledgers.every((ledger) => ledger.pending.length === 0)) return before;
  yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations, table: coreMigrationsTable }).pipe(
    Effect.mapError((cause) => new MigrationFailed({ message: "a core migration failed; none of that batch was applied", ledger: "core", cause })),
  );
  yield* run(plugins).pipe(
    Effect.mapError((cause) => new MigrationFailed({ message: "a plugin migration failed; none of that batch was applied (core migrations already applied stay applied)", ledger: "plugins", cause })),
  );
  return before;
});

/** Refuses on drift or on anything pending; applies nothing. */
export const verify = Effect.fnUntraced(function* (plugins: Migrations) {
  const current = yield* status(plugins);
  if (current.drift) return yield* new LedgerDrift({ message: driftMessage(current), status: current });
  if (current.ledgers.some((ledger) => ledger.pending.length > 0)) {
    return yield* new Pending({ message: pendingMessage(current), status: current });
  }
});

/** What `AuthHost` runs when its SQL layer is built. */
export const onBuild = (mode: OnBuild, plugins: Migrations) =>
  mode === "apply" ? Effect.asVoid(apply(plugins)) : verify(plugins);
```

- `driftMessage` moves from `cli/src/Migration.ts:174-185` unchanged, so the CLI's text output does not change. `pendingMessage` is new (`"2 migration(s) pending: plugins 0001_organization_create_organization, ..."`).
- Concurrency: two replicas booting with `"apply"` may both see a pending batch. `Migrator` takes its ledger lock inside its transaction (`LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` on Postgres, `effect/src/unstable/sql/Migrator.ts:225`) and re-reads the newest id under it, so the second replica applies nothing. The pre-check outside the lock only decides whether to call `Migrator` at all.
- The CLI keeps everything that is about the command line: rendering (`renderStatus`, `renderLedger`), `--dry-run`, `--yes`, `--allow-empty`, `--json`, exit codes. `Migration.status` maps `Migrations.status`'s `SqlError` to `DatabaseUnavailable`; `Migration.apply` keeps its plan/confirmation flow and calls `Migrations.apply` for the write, mapping `Migrations/LedgerDrift` → `LedgerDrift` (exit 7) and `Migrations/MigrationFailed` → `MigrationFailed` (exit 5, the same two messages as today). `Import.ts:108` calls `Migrations.tableExists`.
- The stale paragraph `Migrations.ts:43-67` is replaced by one sentence: the runner is `apply`/`verify`, called by `awthaq migration apply` and by `AuthHost`.

### 3.5 `TestAuth.layer` over `AuthHost`

```ts
// packages/test/src/TestAuth.ts (sketch). `memoryFoundation`, `TestCsrfConfig`, `recordModes`, `app`, `signInAs`,
// `csrfToken`, `buildContext`, `httpClient`, the contract suite: unchanged.

/** The test ports: a cheap real hasher, a capturing mailer, a permissive (or the real) limiter, a fixed key. */
const testPorts = (rateLimiter: "permissive" | "enforcing" | undefined) =>
  Layer.mergeAll(
    TestHasher,
    Mailer.layerMemory,
    rateLimiter === "enforcing" ? RateLimiter.layerMemory : RateLimiter.layerPermissive,
    ClientAddress.layerDirect,
    TestEncryption.layer,
  ).pipe(Layer.provideMerge(NodeCrypto.layer));

const GuardLive = RedactionGuard.layerEvents.pipe(Layer.provideMerge(RedactionGuard.layer));

const makeLayer = <P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint>(
  built: Auth.Built<P, Extra>,
  options: CommonOptions<never, unknown, unknown, never, unknown> & (MemoryMode | SqlMode) = {},
) => {
  const shared = {
    csrf: Layer.succeed(Csrf.CsrfConfig, { ...TestCsrfConfig, ...options.csrf }),
    ...(options.principalResolver === undefined ? {} : { principalResolver: options.principalResolver }),
    services: options.services ?? Layer.empty,
    taps: options.taps ?? Layer.empty,
    // EOTS-002: the guard rides in the decorate slot (above the base, beneath the plugins), where it sat before.
    decorate: (options.decorate ?? Layer.empty).pipe(Layer.provideMerge(GuardLive)),
    tier: options.tier ?? "all",
    // The in-process harness serves without both on purpose, as it always has (`RequestContext` E1; `BodyLimit` has its own suite).
    requestContext: false,
    bodyLimit: false,
    openapiPath: options.openapiPath,
    docsPath: options.docsPath,
  };
  const host =
    options.records === "sql" && "suite" in options
      ? AuthHost.layer(built, { ...shared, persistence: { records: "sql", client: TestSql.layer(options.suite), migrations: "apply" } })
      : AuthHost.layer(built, { ...shared, persistence: { records: "memory" } });
  return host.pipe(
    Layer.provideMerge(testPorts(options.rateLimiter)),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );
};
```

- `CommonOptions` gains `tier?: "all" | "public" | "admin"`, passed through. Its real caller is `AdminTier.test.ts`, whose public-tier case stops being an exemption (§4 Phase 3).
- The `Provided` / overload formula (`:322-332`, `:430-475`) is rewritten in terms of `AuthHost.Provided` and `AuthHost.Requires`, plus `Layer.Success<ReturnType<typeof testPorts>> | Layer.Success<typeof GuardLive> | Layer.Success<typeof HttpServer.layerServices> | HttpRouter.HttpRouter`. Every service in today's `ROut` stays (the base now also merges `Persistence[mode]`'s stores; a superset is harmless).
- `taps` keeps `Layer<never, never, unknown>` at `TestAuth`'s widened implementation, and the overloads forward a generic `T` to `AuthHost`, so a test tap on an undeclared point now fails to compile in a suite too.
- Deleted from `TestAuth.ts`: `SqlStores`, `sqlFoundation`, `coreServices`, `memoryBase`, `sqlBase`, the old `makeLayer` body, and the `CoreMigrations`/`Migrator`/`Persistence`/`RateLimits`/`Slots`/`SqlTransaction`/`Erasure`/`DataExport` imports they used (keep whatever `memoryFoundation`, `applyMigrations` and the contract suite still need; `pnpm lint` and `knip` say which).
- The contract suite's `build` check (`:1199-1204`) keeps calling `makeLayer`, so it now proves every plugin composes through `AuthHost` over both modes.

### 3.6 What a host writes

**`examples/memory-server/app.ts`** (the `:92-190` block becomes):

```ts
const Ports = Layer.mergeAll(
  PasswordHasher.layerArgon2id,
  Mailer.layerConsole,
  RateLimiter.layerMemory,
  ClientAddress.layerDirect,
  Encryption.layer.pipe(Layer.provide(KeyProvider.layerEphemeral)),
).pipe(Layer.provideMerge(NodeCrypto.layer));

export const makeAppLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  AuthHost.layer(built, {
    persistence: { records: "memory" },
    csrf: DemoCsrfConfig,
    // The guard is built over `Roles.layer` (the same reference `Auth.make` installs), so it reads the slot Roles overrides.
    services: Layer.mergeAll(httpClient, GuardLive).pipe(Layer.provideMerge(RolesConfigLive)),
    taps: SignUpAllowList,
  }).pipe(
    Layer.provide(Ports),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );
```

`Foundation`, `Core`, `PluginRecords` and `buildApp`/`RunningApp` are deleted. `serverLayer` keeps `Retention.layerScheduled` and `SecuritySignals.layer` (host-owned jobs) and drops `BodyLimit.layer`/`RequestContext.layer` (now in `AuthHost`). The smoke test builds the handle with `TestAuth.app(makeAppLayer(NoBreachHttpClient).pipe(Layer.provideMerge(CaptureMail)))`: `@awthaq/test` is already a devDependency of the example, and the production module no longer carries a memo-map block.

**`examples/sql-server/app.ts`** (the `:58-194` block becomes):

```ts
// 1. Password and Organization. Add more by listing them: AuthHost selects each plugin's SQL records, provides its
//    hook points and runs its migrations; what is left for you is the ports it requires (the compiler lists them).
const auth = Auth.make([Password.Password, Organization.Organization]);

// `AWTHAQ_MIGRATE_ON_BOOT=false` when `awthaq migration apply` is your deploy step: the server then refuses to start
// while anything is pending, and never migrates itself.
const MigrateOnBoot = Config.Boolean("AWTHAQ_MIGRATE_ON_BOOT").pipe(Config.withDefault(true));
const ExposeDocs = Config.Boolean("AWTHAQ_EXPOSE_DOCS").pipe(Config.withDefault(false));

export const makeAppLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const migrate = yield* MigrateOnBoot;
      const expose = yield* ExposeDocs;
      return AuthHost.layer(auth, {
        persistence: { records: "sql", client: SqlLive, migrations: migrate ? "apply" : "verify" },
        csrf: Csrf.layerConfig,
        ...(expose ? { openapiPath: "/openapi.json", docsPath: "/docs" } : {}),
      });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(PasswordHasher.layerArgon2id, Mailer.layerConsole, RateLimiterLive, ClientAddress.layerDirect, EncryptionLive, httpClient),
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );
```

`SqlLive`, `KeysLive`/`EncryptionLive` and `RateLimiterLive` (its own store and its own ledger) stay: they are the host's database, keys and limiter. `Migrated`, `CoreLive`, `MiddlewareLive`, `ServicesLive`, `RoutesLive`, `DocsLive` and `buildApp` are deleted. `HttpServer.layerServices` replaces the hand-listed `Path`/`Etag`/`HttpPlatform`/`FileSystem.layerNoop` block (`:166-170`), which is what it contains.

**The README quickstart** (`README.md:50-229`) follows the sql-server shape over Postgres with `[Password.Password]`, and its step-1 comment says what `AuthHost` does for an added plugin. Target ≤ 100 lines. `packages/sql/test/fixtures/readme-quickstart.ts` is regenerated from it (the test asserts equality). The "Plugin-specific tables ... see each plugin's own package for its migrations" sentence (`:298`) becomes "`AuthHost` runs them after core's; `awthaq migration apply` runs the same set".

**The CLI's `app`** (`packages/cli/README.md:41-50`): `app: AuthHost.layer(auth, { persistence: { records: "sql", client: SqlLive, migrations: "verify" }, csrf: Csrf.layerConfig }).pipe(Layer.provide(Ports), Layer.provideMerge(HttpRouter.layer))`. `"verify"` because a CLI command that builds the application must never migrate behind `migration apply --yes`.

### 3.7 What stays outside, and why

- **Ports and platform** stay in `RIn` (ADR-EA-010). `AuthHost` is not a "batteries" layer: a missing `Mailer` must stay a compile error.
- **Host jobs and edge middleware** (`Retention.layerScheduled`, `SecuritySignals.layer`, `SecurityHeaders`, `cors`, `layerRedactedHeaders`) merge beside the result; each reads the result's output (`Sessions`, `CsrfConfig`, ...), which `AuthHost` merges.
- **No separate route-less entry point.** A worker or a CLI command builds the same `AuthHost.layer` with `HttpRouter.layer` provided (the routes register on a router nobody serves; a negligible cost). Q7 asks whether an `AuthHost.application` without routes is worth a second overload pair.
- **The SQL rate limiter** (`RateLimiterStoreSql`) is an adapter of the `RateLimiter` port, with its own ledger table: the host's (`examples/sql-server/app.ts:116-125`).

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Phases 1, 2, 3 and 4 also run `pnpm test:pg` (the runner and the SQL host mode run on Postgres) and `pnpm test:bdd`. Plan gate: `pnpm check && pnpm test:pg && pnpm test:bdd && pnpm package:smoke` (Phase 2 adds a server export and a devDependency). One ticket per phase under `.scratch/host-composition/issues/`.

Red-green convention for Phase 0: the red tests are committed as `it.fails` / `it.effect.fails` (both exist in `@effect/vitest` rc.116), so the phase is green and the tests pin the bug; the phase that fixes the bug flips them to `it` / `it.effect`.

### Phase 0: pin the bug (ticket 01)

1. `examples/sql-server/package.json`: add `"@awthaq/organization": "workspace:*"`; `pnpm workspace:sync` adds the project reference.
2. `examples/sql-server/app.ts`: compose `Auth.make([Password.Password, Organization.Organization])` **following the example's own instruction**, nothing more: merge `Organization.Organization.records.sql` and `Organization.Organization.hookPoints` into the pipeline, and `provideMerge` `EncryptionLive` (Organization's records seal the OAuth client secret). Keep the core-only `Migrated`. Update the header comment (`:1-12`): Password and Organization.
3. `examples/sql-server/test/smoke.test.ts`: add
   `it.fails("a plugin that owns tables is served over SQL: a signed-in user creates an organization", ...)`: sign up, read the mailed token, verify, sign in (the existing flow at `:67-91`), then `POST /organization { name: "Acme", slug: "acme" }` with the session cookie and the CSRF pair, and assert `200` and `slug === "acme"`. Today it answers `503 StoreUnavailable` (§2.4).
4. `packages/core/test/Migrations.test.ts`: add
   `it.effect.fails("a boot-time run refuses a plugin inserted before an applied one (it is skipped today)", ...)`: over SQLite `:memory:`, apply core plus `Migrations.run([a, c])`, then run the boot sequence `TestAuth.sqlBase` uses (`Migrator` core + `Migrations.run([a, b, c])`) and assert it fails. Today it succeeds and `b` never runs. Phase 1 rewrites the body against `Migrations.apply`.

Gate: the phase gate. No changeset (examples are private; tests only).

### Phase 1: one migration runner in core (ticket 02)

Files:

1. `packages/core/src/Migrations.ts`: add `coreMigrationsTable`, `Entry`, `LedgerName`, `LedgerReport`, `Status`, `LedgerDrift`, `Pending`, `MigrationFailed`, `OnBuild`, `OnBuildError`, `diff`, `tableExists`, `status`, `apply`, `verify`, `onBuild` (§3.4). Replace the stale comment `:43-67`. Import `CoreMigrations` from `@awthaq/sql`.
2. `packages/cli/src/Migration.ts`: delete `Entry`, `LedgerReport`, `diff`, `tableExists`, `readLedger`, `coreKnown`, `pluginKnown`, `inspect` (`:39-148`); `coreLedgerTable`/`pluginLedgerTable` re-point at core's constants. `status` and `apply` call `Migrations.status(auth.migrations)` / `Migrations.apply(auth.migrations)` and map the errors (§3.4). `StatusReport` becomes `Migrations.Status`. Rendering is unchanged.
3. `packages/cli/src/Import.ts:108`: `Migrations.tableExists(ledgerTable)`.
4. Tests, replace-don't-layer:
   - `packages/core/test/Migrations.test.ts` gains `describe("Migrations.status / apply / verify")` (§5.1). The Phase 0 case is rewritten against `Migrations.apply` and flipped to `it.effect`.
   - `packages/cli/test/Migration.test.ts`: the three drift-detection cases in `describe("Migration.status")` (`:80-116`: unknown id, same id different name, pending before applied) move to core (they test the detection, which now lives there). The CLI keeps "on an empty database lists core then plugin migrations as pending, creating no ledger" (`:63`), one drift case at its interface ("a drifted ledger exits 7 and prints DRIFT", rewritten from `:80`), and every `describe("Migration.apply")` case (`:117-190`, exit codes, `--dry-run`, `--yes`, `--json`, refusal with `--yes`).
   - `packages/cli/test/Migration.postgres.test.ts`: unchanged; it must still pass.
5. `scripts/test-pg.sh`: add `packages/core/test/Migrations.test.ts` to `suites` if absent.
6. Spec: BEH-EA-039 and BEH-EA-204 revisions (§6.1).
7. Changeset `.changeset/migrations-runner.md` (§6.4).

Gate: the phase gate plus `pnpm test:pg`.

### Phase 2: `AuthHost` (ticket 03)

Files:

1. **New `packages/server/src/AuthHost.ts`** (§3.2, §3.3).
2. `packages/server/src/index.ts`: `export * as AuthHost from "./AuthHost.ts";`.
3. `packages/server/package.json`: devDependency `@effect/sql-sqlite-node: "catalog:"` (the SQL-mode suite). `pnpm workspace:sync`.
4. **New `packages/server/test/support/LedgerPlugin.ts`**: a fixture plugin `Ledger` (id `ledger`) owning one table `ledger_entry` with one migration; a record store `LedgerRecords` (key `ledger/records/LedgerRecords`) with `layerMemory` and `layerSql`; a hook point `AfterLedgerEntry` declared as `hookPoints`; a user field `tier: UserFields.field(Schema.String)`; two groups: `ledger` (`POST /ledger`, `GET /ledger`, behind `Api.Authentication` + `Api.CsrfProtection`) and `ledger.admin` (`GET /ledger/admin/count`, admin tier, behind `Api.AdminAuthentication`). It mirrors `packages/test/test/support/Pins.ts` (96 lines); it cannot import it (`@awthaq/server` sits below `@awthaq/test`).
5. **New `packages/server/test/support/HostPorts.ts`**: the ports a host owns, for these suites (a cheap argon2id hasher, `Mailer.layerMemory`, `RateLimiter.layerPermissive`, `ClientAddress.layerDirect`, `Encryption` over a fixed key, `NodeCrypto.layer`, `HttpServer.layerServices`, `HttpRouter.layer`). It reuses `support/Wiring.ts`'s CSRF config and token mint.
6. **New `packages/server/test/AuthHost.test.ts`** and **`AuthHost.types.test.ts`** (§5.1).
7. `scripts/test-pg.sh`: no server entry. `AuthHost`'s SQL cases run on SQLite in its own suite (the server package cannot import `TestSql`, and a copy of its per-suite schema reset would be a second one); Phase 3 adds `packages/test/test/TestAuthHost.test.ts` to `suites`, which runs `AuthHost`'s SQL mode on Postgres through `TestSql`.
8. `packages/server/README.md`: a new section "Serving a composition (`AuthHost`)" before "Request context": the composition-owned/host-owned table of §3.1, both persistence modes, `migrations: "apply" | "verify"`, the dials, and the rule that `RIn` is the host's to-do list. The "Request context" section says `AuthHost` installs it by default.
9. Spec: new BEH-EA-H1, H2 (§6.1); ADR-EA-044 (§6.2).
10. Changeset `.changeset/auth-host.md` (§6.4).

Gate: the phase gate plus `pnpm test:pg` and `pnpm package:smoke`.

### Phase 3: `TestAuth.layer` over `AuthHost` (ticket 04)

Files:

1. `packages/test/src/TestAuth.ts`: §3.5. Rewrite the header paragraph that lists what is built (`:416-426` in the `layer` doc) to "`AuthHost.layer` plus the test ports, the redaction guard and the HTTP platform".
2. `packages/test/test/TestAuthHost.test.ts` (new) and an addition to `TestAuthRecords.types.test.ts` (§5.2). `scripts/test-pg.sh`: add `packages/test/test/TestAuthHost.test.ts` to `suites` (it is the Postgres run of `AuthHost`'s SQL mode).
3. `packages/admin/test/AdminTier.test.ts`: the public-tier case (`:77-127`) becomes `TestAuth.app(TestAuth.layer(auth, { tier: "public", services: Admin.config(...) }))` and asserts `/admin` → 404 while `/session` → 401. Delete its `TestServices`/`CoreLive`/`CsrfProtectionLive`/`AuthenticationLive` block and its "Hand-wired on purpose" comment. The other two cases (`adminApi`/`publicApi` group keys; the swapped `AdminAuthentication`) are unchanged.
4. `packages/test/README.md:5`: "`TestAuth.layer` is `AuthHost.layer` (from `@awthaq/server`) over the test ports and the redaction guard".
5. Spec: BEH-EA-193/331/332 revisions and BEH-EA-H3 (§6.1).
6. Changeset `.changeset/test-auth-on-auth-host.md` (§6.4).

Gate: the phase gate, `pnpm test:bdd` (every World that uses `TestAuth.layer`/`TestAuth.app` must report the same passed/skipped counts as before the phase) and `pnpm test:pg`.

### Phase 4: the examples, the README, the CLI suites (ticket 05)

Files:

1. `examples/memory-server/app.ts` (§3.6) and `examples/memory-server/test/smoke.test.ts` (`TestAuth.app(...)`, `app.run` replaces `withServices`). `examples/memory-server/index.ts` header: "`AuthHost.layer` over `Persistence.memory`".
2. `examples/sql-server/app.ts` (§3.6), `examples/sql-server/index.ts` header, `examples/sql-server/README.md` (`AWTHAQ_MIGRATE_ON_BOOT`, Organization), and `examples/sql-server/test/smoke.test.ts`:
   - flip the Phase 0 case to `it(...)`;
   - the restart case (`:93`) keeps two boots on one file, through `TestAuth.app`: the second boot applies nothing;
   - add "with AWTHAQ_MIGRATE_ON_BOOT=false a fresh database refuses to boot and names the pending migrations": building the app over an empty SQLite file fails with `Migrations/Pending` whose message lists `0001_organization_...`.
   - the `env` the old `buildApp` took becomes `Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))` in the test.
3. `README.md:50-229`, `:283` (the "exact composition was run" paragraph: re-run it and say so), `:298`, and the CORS snippet `:365-369` (`Layer.mergeAll(AuthHost.layer(auth, {...}), AuthHttp.cors())`). Regenerate `packages/sql/test/fixtures/readme-quickstart.ts`. `pnpm check:readmes` must pass.
4. `packages/cli/test/support/SqlApp.ts`: `sqlApp(sql)` becomes `AuthHost.layer(passwordAndRoles, { persistence: { records: "sql", client: Layer.succeed(SqlClient.SqlClient, sql), migrations: "verify" }, csrf, services: Roles.config([adminRole, editorRole]) })` over the suite's ports (the legacy verifiers stay in its `PasswordHasher`), plus `HttpRouter.layer`; `migrate` becomes `Migrations.apply(passwordAndRoles.migrations)`. `sqlAppWithoutRoles` composes `Auth.make([Password.Password])` the same way. Keep the test count of every CLI suite that uses it identical. If the result is not shorter than today's 115 lines, keep the file and record why in the ticket (plan 08's "the saving is nil" rule).
5. `packages/cli/README.md:41-50` (§3.6, the `"verify"` reasoning), `packages/next/README.md:250` (the `AppRoutesLayer` comment points at `AuthHost.layer`), `docs/plugin-authoring.md:211` and `:215` (§6.3).
6. Spec: overview, glossary, invariants (§6.1), the ADR revisions (§6.2), traceability (§6.3).
7. No package changeset for the examples (private); `.changeset/auth-host-docs.md` only if a package README changed in a way `pnpm check:readmes` attributes to a package (it does for `@awthaq/cli` and `@awthaq/next`: patch).

Gate: the plan gate.

---

## 5. Test plan

### 5.1 New tests at the deepened interfaces

`packages/core/test/Migrations.test.ts`, `describe("Migrations.status / apply / verify")`, SQLite `:memory:` (and Postgres under `pnpm test:pg`):

1. `status: an empty database lists core then plugin migrations as pending and creates no ledger table`
2. `status: drift when a ledger holds an id the linker does not produce` (moved from `cli/test/Migration.test.ts:80`)
3. `status: drift when a same-id row carries a different name` (moved from `:93`)
4. `status: drift when a pending id sorts before an applied one` (moved from `:105`)
5. `apply: core first, then plugins, each into its own ledger; a second apply calls no Migrator and applies nothing`
6. `apply: refuses a drifted ledger with Migrations/LedgerDrift and applies nothing` (the Phase 0 case, flipped)
7. `apply: a failing plugin migration is Migrations/MigrationFailed { ledger: "plugins" }, and core's batch stays applied`
8. `verify: succeeds on a current schema and applies nothing`
9. `verify: refuses with Migrations/Pending naming every pending entry, and creates no ledger table`
10. `verify: refuses a drifted ledger with Migrations/LedgerDrift`
11. `apply: two concurrent applies on one database apply each migration once` (fork two `apply`s over one file-backed SQLite / one Postgres schema)

`packages/server/test/AuthHost.test.ts`, over the `Ledger` fixture, both modes unless stated (`for (const records of recordModes)`, with `const recordModes: readonly ["memory", "sql"] = ["memory", "sql"]` in the support file, the way `TestAuth.recordModes` is declared at `TestAuth.ts:274`; no `as const`). The SQL cases run on SQLite; the Postgres path of the same module is exercised under `pnpm test:pg` by `TestAuthRecords.test.ts` and `TestAuthHost.test.ts`, which reach `AuthHost` through `TestAuth`'s `TestSql` client:

12. `BEH-EA-H1: serves the composition with no hand-built middleware, records, hook points or core services` (`POST /ledger` 200 with a session and CSRF pair; `GET /session` 401 without a session)
13. `BEH-EA-H1: the plugin's records bundle for the mode is the one the plugin writes through` (sql: the row is visible through `yield* SqlClient.SqlClient` on `ledger_entry`)
14. `BEH-EA-H1: a host tap receives the plugin's own hook point instance` (`taps: AfterLedgerEntry.tap(...)` records the entry)
15. `BEH-EA-H1: declared user fields are validated and served` (`PATCH /user { fields: { ledger_tier: "gold" } }` 200, read back through `GET /user`; sql: the column exists)
16. `BEH-EA-H2 (sql): apply migrates an empty database before any service is built, and a second build applies nothing` (two builds over one file)
17. `BEH-EA-H2 (sql): verify refuses an unmigrated database with Migrations/Pending and builds nothing over the client`
18. `BEH-EA-H2 (sql): apply refuses a drifted ledger and the layer fails to build`
19. `AR-003: tier "public" answers the admin group with 404 and serves session/account; tier "admin" serves only the admin group` (`/session` 404 there)
20. `requestContext (default): a minted session records the client address and user agent; requestContext: false records none and logs no warning`
21. `bodyLimit (default): a body over the limit is 413; bodyLimit: false lets it through`
22. `services: a host layer that provides a plugin's config is the one the plugin reads, and is in the output`
23. `decorate: a decorated Sessions that fails issue makes POST /ledger's sign-in path answer 503, and the output holds the decorated instance`
24. `principalResolver: PrincipalResolverWithUserFactsLive puts emailVerified on the principal`

`packages/server/test/AuthHost.types.test.ts` (compile-time; a token runtime `it`, the pattern of `MiddlewareFor.types.test.ts`):

25. `Requires<…>` of `AuthHost.layer(Auth.make([Ledger]), { persistence: { records: "memory" }, csrf })` **equals** the host-owned set the compiler reports for core plus the fixture (`Equals<A, B>` helper). The reference is the §2.7 probe for `[Password, Organization]`: `Crypto | ClientAddress | Mailer | PasswordHasher | RateLimiter | Encryption | HttpClient | Serving`. `HttpClient` there is Password's breach check and `Encryption` Organization's sealed column, so the fixture's set is a subset; the executor pins what the compiler reports for `[Ledger]` (and adds a second assertion for `[Password, Ledger]`), then keeps it.
26. The same over `{ records: "sql", client: SqliteClient.layer(...) , migrations: "apply" }` equals the memory set (the client's own requirement is `never`).
27. `// @ts-expect-error` assigning the layer with every port but `Mailer` provided to `Layer.Layer<unknown, unknown, never>` (BEH-EA-014 through `AuthHost`).
28. `// @ts-expect-error` on `{ records: "sql", client }` without `migrations`.
29. `// @ts-expect-error` on options without `csrf`, and without `persistence`.
30. A tap on a point the composition does not declare leaves that point in `Requires` (`Includes<Requires<…>, typeof Foreign>`).
31. `Layer.Success` includes `AuthPlugin.RecordsOut<typeof Ledger>`, `HookPointsOut`, `Users.Users`, `SqlClient.SqlClient` (sql only).

### 5.2 The harness on the host module

`packages/test/test/TestAuthHost.test.ts` (new): the contract that the harness and production share the wiring.

32. `TestAuth.layer(built) is AuthHost.layer(built) plus exactly the test-only services`: build both for `Auth.make([Pins])` in both record modes (the `AuthHost` side over `testPorts`-equivalent ports built in the test, `requestContext: false`, `bodyLimit: false`), list each context's keys (`keysOf`, `TestAuth.ts:964`), and assert `TestAuth`'s keys minus `AuthHost`'s are exactly the `RedactionGuard` keys and that `AuthHost`'s keys are a subset of `TestAuth`'s. A future hand-fork of the base fails this.
33. `TestAuth.layer({ tier: "public" }) serves no admin group` (one case; `AdminTier.test.ts` is the main caller).

`packages/test/test/TestAuthRecords.types.test.ts`: add `// @ts-expect-error` on a `taps` layer that taps a point no composed plugin declares (the `T` forwarding of §3.5).

All 18 existing `packages/test/test/*.test.ts` files must pass unchanged, and every `TestAuth.layer` caller (99 files) unchanged except `AdminTier.test.ts`.

### 5.3 BDD (`features/`)

REQ ids are allocated with `python3 features/scripts/allocate-req-ea.py` (never by hand; the current maximum is REQ-EA-1306, and sibling plans allocate too).

- `00-foundations/02-plugin-composition-validate.feature`, new `Rule: AuthHost derives the servable layer, and the host provides only what it owns` (BEH-EA-H1):
  - "A host that omits a port does not compile": a `CompileTimeGates.ts` block `// type-gate: auth-host-missing-port` (every port but `Mailer`), driven by the existing `assertTypeGate` step.
  - "A composition with a table-owning plugin is served over SQL with no hand-run migration" (CompositionSteps: build `AuthHost.layer(Auth.make([Organization]), sql apply)`, create an organization through `app.request`).
- `01-contract-and-persistence/05-persistence-stratum.feature`, new `Rule` under BEH-EA-H2:
  - "A server in verify mode refuses to start while migrations are pending"
  - "A boot that would skip a plugin migration refuses to start" (the ledger-drift case)
  - Update the BEH-EA-039 rule's comment (the key-level check is shared with the host module).
- `08-tooling/25-testing-harness.feature`, under BEH-EA-H3: "The harness serves the same wiring a host composition serves" (drives §5.2 item 32's comparison through `TestingHarnessSteps.ts`).
- Must pass unchanged in meaning: every scenario of `26-cli.feature` under BEH-EA-204, `02-plugin-composition-validate.feature`'s BEH-EA-014 rule, every World on `TestAuth`.

### 5.4 Tests deleted or moved, by name

- Moved to core (§5.1 items 2-4): `packages/cli/test/Migration.test.ts` "reports drift (exit 7) when a ledger holds an applied id the linker does not know" (kept at the CLI in a shortened form as the exit-code case), "reports drift when a same-id row carries a different name (the plugin set changed under the ledger)", "reports drift when a pending id sorts before an applied one".
- Rewritten, not added: `examples/memory-server/test/smoke.test.ts` and `examples/sql-server/test/smoke.test.ts` keep every case (5 and 2) and build through `TestAuth.app`; `AdminTier.test.ts`'s public-tier case.
- Deleted code: `buildApp`/`RunningApp` in both examples (two of the seven remaining hand-built memo maps in plan 08's follow-up count), `TestAuth.ts`'s `SqlStores`/`sqlFoundation`/`coreServices`/`memoryBase`/`sqlBase`, the CLI's `inspect`/`diff`/`tableExists`/`readLedger`/`coreKnown`/`pluginKnown`.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (each with a Document Control revision and a change-history line)

New BEH ids are appended at execution time from the next free number (`grep -rhoE '^## BEH-EA-[0-9]+' spec/behaviors/*.md | sort -t- -k3 -n | tail -1` reads BEH-EA-337 today; sibling plans allocate too). Placeholders **H1-H3**.

| Placeholder | File | Title | Requirement |
|---|---|---|---|
| H1 | `02-plugin-composition-validate.md` | `AuthHost.layer` derives the servable layer from `Auth.make`, and its requirements are exactly what the host owns | `AuthHost.layer(built, options)` MUST serve `built.api` (or the selected tier) with core's handlers, every composed plugin's records bundle for the chosen persistence and its declared hook points, core's services and registries, the host middleware the groups declare and the composition's user-field registry, without the host providing any of them. Its `RIn` MUST be exactly the ports, adapters and platform services the composition requires that are not composition-owned, so omitting one MUST fail to compile. `persistence` and `csrf` MUST be required options. |
| H2 | `05-persistence-stratum.md` | A SQL host composition never serves a schema that is behind it | With `records: "sql"`, `migrations` MUST be required. `"apply"` MUST run core's pending migrations and then the composition's (user-field columns included) before any service is built over the client, and MUST NOT call the migrator when nothing is pending. `"verify"` MUST apply nothing and MUST refuse the build with `Migrations/Pending`, naming every pending migration. Both MUST refuse a ledger that disagrees with the linker (`Migrations/LedgerDrift`), by the same check `awthaq migration apply` uses. |
| H3 | `25-testing-harness.md` | `TestAuth.layer` is `AuthHost.layer` over the test ports | `TestAuth.layer` MUST be built by `AuthHost.layer` with the test ports, the redaction guard and the HTTP platform beneath it, so the harness and a production host share every composition-owned element; a test MUST fail if the two diverge beyond the test-only services. `tier` MUST select the served groups as `AuthHost`'s does. |

Revisions:

- `02-plugin-composition-validate.md` 1.2 → 1.3: H1; **BEH-EA-014** gains "*As shipped (ADR-EA-044):* `AuthHost.layer` carries the guarantee to the whole servable pipeline: its `RIn` lists only host-owned services, and the migrations, which are not a service, are run or verified by the layer itself (BEH-EA-H2)."
- `05-persistence-stratum.md` 1.5 → 1.6: H2; **BEH-EA-039**'s requirement becomes: "The runtime (`Auth.make`, `auth.layer`, `auth.migrations`) MUST NOT depend on a snapshot-diff planner or a checksum ledger. The key-level ledger check (an applied id the linker does not produce, a pending id that sorts before an applied one) is core's `Migrations.status`, shared by `awthaq migration apply` and `AuthHost`'s SQL mode; snapshot diffing and checksums remain a deferred CLI feature." Its "First CLI guardrails" paragraph names `Migrations.apply`/`verify`.
- `11-http-error-mapping.md` 1.3 → 1.4: **BEH-EA-083** ("no additional wiring step") and **BEH-EA-085** gain an *As shipped* line: a host serves `AuthHost.layer(...)` through either path; `AuthHttp.routes` stays the primitive `AuthHost` and the middleware suites use.
- `25-testing-harness.md` 1.4 → 1.5: H3; **BEH-EA-193**'s *As shipped* note: built on `AuthHost.layer`; **BEH-EA-331**: the derivation is `AuthHost`'s; **BEH-EA-332**: the migration run is `Migrations.apply`, with the drift refusal.
- `26-cli.md` 1.4 → 1.5: **BEH-EA-204** *As shipped*: the ledger diff is core's `Migrations.status`; `apply` writes through `Migrations.apply`; behaviour, output and exit codes unchanged.
- `01-plugin-contract.md` 1.3 → 1.4: **BEH-EA-334** (records bundles) adds "a host selects them through `AuthHost`'s `persistence`, never by name".
- `03-ports-slots-hooks-registries.md` 1.4 → 1.5: **BEH-EA-335** (declared hook points): "`AuthHost.layer` provides every declared point once, beneath the host's `taps`, in production as in the harness" (this reverses plan 08 Q5's "no"; Q9 below).
- `spec/overview.md` 1.9 → 1.10: the stratum-7 row reads "`Auth.make([...])`, `AuthHost.layer(auth, {...})`, and the application's ports"; the HTTP-stratum row adds `AuthHost`; the composition-stratum table adds `AuthHost.layer` (function, `@awthaq/server`, `AuthHost.ts`); the worked example (`:186-205`) is marked illustrative and pointed at `AuthHost` and the README.
- `spec/glossary.md` 1.5 → 1.6: new **AuthHost** entry ("the module that turns an `Auth.make` result into the servable layer; the host provides persistence, the CSRF secret, its ports and its policy layers"); **Port** gains "core services, records bundles, hook points and registries are not ports: the composition owns them (ADR-EA-044)"; **Auth.make** gains "served with `AuthHost.layer`"; **TestAuth** gains "`AuthHost.layer` over test ports".
- `spec/invariants.md` 1.5 → 1.6: **INV-EA-002**'s Source names `AuthHost.layer`'s `RIn`; new **INV-EA-<next>** (019 today) "A SQL composition served through `AuthHost` is never built over a schema behind it" (Enforcement: `Migrations.onBuild` inside the client's only path; `AuthHost.test.ts` items 16-18).

### 6.2 Decisions

- **New ADR-EA-044** (`spec/decisions/044-host-composition.md`, number reserved for this plan) and its `index.yaml` entry. "The Servable Composition Is Derived From `Auth.make` by One Host Module; the Host Provides Only What It Owns". Contents:
  - Context: §1.1, the copies (§2.2), the reproduced bug (§2.4), the two non-service items the compiler cannot guard (migrations, the user-field reference).
  - Decision: (1) `AuthHost.layer` in `@awthaq/server`; (2) the composition-owned / host-owned split of §3.1 and its rule; (3) `RIn` is exactly the host-owned remainder; `persistence`, `csrf` and, for SQL, `migrations` are required; (4) SQL mode runs or verifies migrations inside the client's only path, through core's `Migrations` runner, which also serves the CLI; (5) declared hook points are provided in production, beneath the host's `taps` (closing ADR-EA-033's "different layer graph" hazard for every host that uses the module); (6) `TestAuth.layer` is this module over test ports.
  - Alternatives considered: (a) a `serve`/`layer` member on `Auth.Built` (rejected: `@awthaq/core` cannot depend on `@awthaq/server`, and the built value would have to carry a persistence choice); (b) a recipe in the docs (rejected: the copies already are recipes, and they drifted); (c) separate exported pieces (`AuthHost.base`, `AuthHost.records`, `AuthHost.points`) the host composes (rejected: shallow; the order is the hard part); (d) defaulting `migrations` to `"apply"` (rejected for the type-system-first rule; Q2); (e) a "batteries" variant that also provides default ports (rejected: ADR-EA-010); (f) a new `@awthaq/host` package (Q1).
  - Consequences: §7.
- **ADR-EA-001** 1.1 → 1.2: Consequences gains "Composing the servable layer is still `Layer` algebra: `AuthHost` is one function over the static tuple, with no runtime of its own (ADR-EA-044)."
- **ADR-EA-005** 1.3 → 1.4: Consequences gains "`AuthHost.layer` is a pure function of the static tuple and the host's options; the tuple's migrations are run or verified before the layer serves (ADR-EA-044)."
- **ADR-EA-010** 1.2 → 1.3: Decision gains "What the composition owns (core services, records bundles, hook points, registries, derived middleware) is not a port; `AuthHost` provides it and still never provides a port, which stays in `RIn` (ADR-EA-044)."
- **ADR-EA-033** 1.1 → 1.2: the Negative consequence ("a tap built in a different layer graph from its point silently has no effect") adds "A host on `AuthHost` passes taps through `taps`, which is built over the composition's own point instances; a tap on an undeclared point fails to compile."
- **ADR-EA-035** 1.0 → 1.1: decision 5 reads "`AuthHost.layer` (and therefore `TestAuth.layer`) provides it; a hand-built composition must provide `auth.userFieldsLayer` itself."
- **ADR-EA-041** 1.1 → 1.2: decision 4 gains "A host chooses the bundle once, as `AuthHost`'s `persistence`; the same choice selects every plugin's records bundle." Plans 16 and 23 also revise ADR-EA-041: whichever lands first takes 1.2, the next 1.3.

### 6.3 Traceability and docs

- `spec/traceability.md`: §1 rows for files 02, 05 and 25 list H1/H2/H3; §2 URS crosswalk adds H1 beside BEH-EA-014 and H3 beside BEH-EA-193; §5 test mapping adds rows for `packages/server/test/AuthHost.test.ts`, `AuthHost.types.test.ts`, `packages/test/test/TestAuthHost.test.ts`, the new `Migrations.test.ts` describe, and rewrites the `packages/cli/test/Migration.test.ts` row (`:288`: the detection cases moved to core) and the `AdminTier.test.ts` mention; a new decisions row for ADR-EA-044; the Document Control row gets a change-history entry.
- `features/traceability.md`: regenerated by the allocator.
- `docs/plugin-authoring.md`: `:211` "Declaring them does not make `Auth.make` provide them in production ..." → "`AuthHost.layer` provides every declared point once in production, beneath the host's `taps`; `TestAuth.layer` does the same in tests". `:215` adds "it is `AuthHost.layer` over test ports". The checklist is unchanged.
- `packages/server/README.md` (Phase 2), `packages/test/README.md` (Phase 3), `README.md`, `packages/cli/README.md`, `packages/next/README.md`, `examples/*/README.md` (Phase 4). `packages/sql/README.md:117` ("Two ledgers"): "`AuthHost` and `awthaq migration apply` run them in this order, refusing a drifted ledger." Do not touch `:9-25` or `:64` (plan 16).

### 6.4 Changesets (ADR-EA-034; every package is in the fixed group)

- Phase 1, `.changeset/migrations-runner.md`, `"@awthaq/core": minor`, `"@awthaq/cli": patch`:
  > `Migrations.status`, `apply`, `verify` and `onBuild` run core's and the composition's migrations with the ledger-drift refusal `awthaq migration apply` already had (BEH-EA-204, BEH-EA-H2); new errors `Migrations/LedgerDrift`, `Migrations/Pending`, `Migrations/MigrationFailed`. The CLI's output and exit codes are unchanged.
  >
  > Migration: code that ran `Migrator.make({})({ loader: CoreMigrations.coreMigrations })` and then `Migrations.run(auth.migrations)` at boot should call `Migrations.apply(auth.migrations)` (or let `AuthHost` do it): the two-step form silently skips a plugin migration that sorts before an applied one.
- Phase 2, `.changeset/auth-host.md`, `"@awthaq/server": minor`:
  > `AuthHost.layer(auth, { persistence, csrf, ... })` turns an `Auth.make` result into the servable layer: routes, core handlers, every plugin's records bundle and hook points, core services and registries, the derived middleware, user fields, `RequestContext` and `BodyLimit`, and in SQL mode the migrations (`migrations: "apply" | "verify"`). Its requirements are exactly the ports and platform services the host owns (ADR-EA-044, BEH-EA-H1, BEH-EA-H2).
  >
  > Migration: none required (additive). A hand-built host composition can be replaced by one call; keep your ports, your `SqlClient` and your jobs (`Retention.layerScheduled`, `SecuritySignals.layer`) beside it, and drop `BodyLimit.layer`/`RequestContext.layer` from your own list (or pass `bodyLimit: false` / `requestContext: false`).
- Phase 3, `.changeset/test-auth-on-auth-host.md`, `"@awthaq/test": minor`:
  > `TestAuth.layer` is now `AuthHost.layer` over the test ports and the redaction guard (BEH-EA-H3), and takes `tier: "all" | "public" | "admin"`. A tap passed in `taps` must tap a point the composition declares (it now fails to compile otherwise).
  >
  > Migration: none for callers that already compile. A suite whose `taps` tapped an undeclared point (it never ran) must compose the plugin that owns the point.
- Phase 4: `.changeset/auth-host-docs.md`, `"@awthaq/cli": patch`, `"@awthaq/next": patch` (README recipes only). `Migration:` none.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **Type-level cost.** `AuthHost.layer`'s formula is `TestAuth`'s plus `BaseIn`; large compositions (Organization: 46 hook points, 7 stores) could slow `tsc` or produce opaque errors | Phase 2 measures `pnpm typecheck` wall time on `packages/organization` and `features` before and after, budget +10 %. The errors are ordinary "`X` is not assignable to `never`" diagnostics naming the missing service (BEH-EA-014's format), which is the point |
| **Booting migrates production.** `"apply"` on every replica at start | `migrations` is required, so it is a decision at the call site. Concurrent applies are serialized by `Migrator`'s ledger lock (§3.4, test 11). `"verify"` exists for a separate deploy step, and the CLI's `app` recipe uses it |
| **A drift refusal blocks a boot that used to "work"** (silently skipping a migration) | Intended: the old boot served a schema missing tables. The error names the entries and points at `awthaq migration status`. The changeset says so |
| **`BodyLimit` on by default caps a host's own large-body route on the same router** | `bodyLimit: false`, or `BodyLimit.config({ maxBytes })`; the server README says so; Q3 |
| **`RequestContext` on by default changes what a host's sessions record** | It records what the examples already record (both install it). Hosts that hand-wired without it gain device info; TestAuth keeps it off. Q3 |
| **The harness regresses** (99 files use `TestAuth.layer`; the guard moves into `decorate`'s slot) | Phase 3 runs the full `pnpm test` and `pnpm test:bdd` and compares the counts; `TestAuthHost.test.ts` pins the key sets; the guard sits where it sat (above the base, beneath records), only its slot name changes |
| **`services` versus base shadowing surprises a host** (plan 08's measured semantics: the base instance wins in the output for a key both provide) | Written into `Options.services`' doc and the server README; `decorate` is the documented way to replace a composition-owned service for everyone |
| **Memoization identity.** The host re-providing a composition-owned layer (memory-server's guard over `Roles.layer` and `Slots.layer`) | Same reference, same instance within one build (§2.7); smoke test "Path B RequirePermission" (`examples/memory-server/test/smoke.test.ts:97`) is the regression check |
| **Moving the drift check changes CLI text** | `driftMessage` moves unchanged; the remaining CLI tests assert the text and exit codes |
| **Plan 24 lands later and turns memory records into SQLite `:memory:`** | `AuthHost`'s `persistence: { records: "memory" }` is the only place a memory composition is assembled, so 24 changes one module (it would run `"apply"` itself over its own client) and no host |
| **README drift** | `ReadmeQuickstart.test.ts` still compiles the fixture; `pnpm check:readmes` |

**Rollback.** Phase 0 is tests and one example change. Phase 1 is self-contained (core runner plus the CLI delegating); reverting it restores the CLI's private copy. Phase 2 is additive (a new module). Phase 3 reverts `TestAuth.ts` to its own base without touching callers (the options type only gained `tier`). Phase 4 is per-file (each example, the README, the CLI suite).

---

## 8. Interactions with other plans

**Done (01-10):**

- **08** (test composition): this plan finishes what 08 started. 08 put `records`/`hookPoints` on the plugin and `middlewareFor` in the server, and its §3.5 promised that "a host gets the same leverage"; the host still had to select by hand (§2.3). 08's Q5 ("no production hook points") is reversed for `AuthHost` hosts (Q9). 08's Q1 decisions stand: `SecondFactor`'s gates and `Sso`'s `OrganizationConnections.layerStore` stay host-owned (`services`). 08's `services`/`decorate` semantics carry over unchanged. Two of 08's seven remaining hand-built memo maps (the examples) and one exemption (`AdminTier`) go.
- **02** (store seam): `Persistence.memory`/`Persistence.sql()` are the two bundles `AuthHost` chooses between.
- **05** (plugin table substrate): plugin `records.sql` run over the one client; `TenantScope.enableRls({ plugins: auth.tenancy })` stays a host step (an operator's reversible choice, `packages/sql/README.md:161`).
- **01** (sign-in/sign-up): decision 7 kept `RequestContext.layer` opt-in for hand-wired compositions; `AuthHost` installs it by default (Q3), which is what plan 01 phase 6 wanted for the hosts that use the module.
- **03, 06, 09, 10**: `Erasure.layer`/`DataExport.layer`, `RateLimits.layer` and the registries `Hooks.HooksLive` carries (erasure, export, retention) are in `AuthHost`'s base; nothing else changes.
- **04**: `Organization`'s `hookPoints` and `ConnectionRecords` arrive through the bundle; `Sso`'s connection store stays in `services`.
- **07**: none.

**Siblings (11-24):**

- **11 credential-resolution**: `AuthHost` derives the middleware through `AuthHttp.middlewareFor` and passes `principalResolver`. If 11 adds a credential-resolution layer every composition needs, it joins `AuthHost`'s registries (one place) instead of every host. 11's `web`/`next` `getSession` read a layer a host builds with `AuthHost`.
- **12, 13, 14, 18, 19, 21**: no shared files. (21's OpenAPI no-store annotation reaches `AuthHost`'s `openapiPath` for free.)
- **16 sql-store-adapters**: `AuthHost` calls `Persistence.sql(options)` only, so folding `Repositories.ts` into the store adapters is invisible here. 16 rewrites `packages/sql/README.md:9-25` and should re-test or drop the `regclass` note at `:64`, which did not reproduce (§2.6). This plan edits only `:117`.
- **17 core-sealed-columns**: if `Persistence.SqlOptions.encryptPii` changes or goes, `SqlPersistence.options` follows (it is typed as `Persistence.SqlOptions`, not restated).
- **20 in-process-user-agent**: the example smoke tests move onto `TestAuth.app` here, so 20's shared user agent reaches them without a second edit. Land 15 first, or rebase 20's example edits.
- **22 table-ddl-locality**: changes what `built.migrations` contains, not who runs it.
- **23 relay-cursor-store**: a `RelayCursorStore` that joins the `Persistence` bundles is provided by `AuthHost` automatically; the relay worker itself is a host job and stays beside the layer.
- **24 memory-records-over-sqlite**: §7. If 24 is accepted, memory mode becomes "SQL over SQLite `:memory:` with `migrations: \"apply\"`" inside `AuthHost`, and ADR-EA-044 decision 4 already covers it.

---

## 9. Acceptance checklist

- [ ] `packages/server/src/AuthHost.ts` exists and is exported as `AuthHost` from `@awthaq/server`; `persistence` and `csrf` are required, and `migrations` is required in SQL mode (type tests 28-29).
- [ ] `Requires<…>` for the fixture composition equals the expected host-owned union, and a composition missing one port fails to compile (type tests 25-27).
- [ ] No `as` (including `as const`), no return-type annotation on a new Effect/Layer const, no `Effect.die` on `SqlError` in the touched source.
- [ ] `Migrations.status/apply/verify/onBuild` live in core; the CLI's `inspect`/`diff`/`tableExists` are gone from `packages/cli/src/Migration.ts`; CLI output and exit codes unchanged (`Migration.test.ts`, `Migration.postgres.test.ts`, `26-cli.feature`).
- [ ] `examples/sql-server` composes `Password` and `Organization`; its Phase 0 case passes as `it(...)`; the verify-mode case passes.
- [ ] `TestAuth.layer` is built on `AuthHost.layer`; `TestAuthHost.test.ts` passes; every existing `TestAuth` suite and World passes with the same counts.
- [ ] `AdminTier.test.ts` has no hand-wired listener and no exemption header.
- [ ] Neither example's `app.ts` contains `makeMemoMapUnsafe`, `Persistence.`, `.records.`, `hookPoints`, `coreHandlers` or `middlewareFor` (`grep`).
- [ ] The README quickstart uses `AuthHost.layer`, ≤ 100 lines, and `ReadmeQuickstart.test.ts` passes.
- [ ] Line targets of goal 6 met and recorded in the ticket.
- [ ] H1-H3 appended with real ids; BEH-EA-014/039/083/085/193/204/331/332/334/335 revised with revision bumps; overview, glossary and invariants updated; ADR-EA-044 added and indexed; ADR-EA-001/005/010/033/035/041 revised; `spec/traceability.md` and `features/traceability.md` updated; `pnpm spec:verify:strict` passes.
- [ ] Changesets for phases 1-4 with `Migration:` lines.
- [ ] `pnpm check`, `pnpm test:pg`, `pnpm test:bdd` and `pnpm package:smoke` green on the final commit.

---

## 10. Open questions only the user can answer

1. **Where the module lives.** `AuthHost` in `@awthaq/server` (recommended: the server already depends on core and owns `AuthHttp` and the middleware; no new package), or a new `@awthaq/host` package above server so the HTTP stratum stays "middleware and handlers" only?
2. **`migrations` with no default.** Required in SQL mode (recommended: which process migrates is a deployment decision, and the compiler should make the host say it), or default `"apply"` for a shorter quickstart?
3. **Edge middleware defaults.** Install `RequestContext.layer` and `BodyLimit.layer` by default with `false` dials (recommended: both examples and the README already install them, every production host needs them, and plan 01's opt-in was about hand-wired compositions), or keep both host-owned?
4. **`examples/sql-server` keeps `Organization`.** Make the SQL example a two-plugin composition permanently (recommended: it is the only proof in the repo that a table-owning plugin migrates and serves over SQL from a production module), or revert to Password-only after the bug is fixed and keep the proof in `AuthHost.test.ts`?
5. **The README quickstart.** Rewrite it on `AuthHost` (recommended: ~180 → ≤ 100 lines, and it stops teaching the hand-wired middleware), or keep the long form as an "everything explicit" walkthrough and add a short `AuthHost` version beside it?
6. **The ledger check in the runtime.** Move the key-level drift check from the CLI into core's `Migrations` and revise BEH-EA-039's "MUST live in the CLI" (recommended: a boot-time apply without it silently skips migrations; snapshot diffing stays CLI-only), or keep it CLI-only and make `AuthHost` support only `"verify"`?
7. **A route-less entry point.** Add `AuthHost.application(auth, options)` (the same composition with no routes, for CLI commands, workers and scripts), or document `AuthHost.layer(...).pipe(Layer.provideMerge(HttpRouter.layer))` for them (recommended: the second; the routes cost nothing to register and one overload pair is enough)?
8. **The CLI's `app` recipe.** Recommend `migrations: "verify"` for `defineConfig({ app })` (recommended: a `seed admin` or `import` run must never migrate behind `migration apply --yes`), or `"apply"` for convenience on a dev database?
9. **Production hook points (reverses plan 08 Q5).** Plan 08 decided that declared `hookPoints` are not provided in production, for fear that an application tap built elsewhere would bind a second instance. `AuthHost` provides them, beneath its `taps` option, in the same graph. Accept the reversal (recommended), or keep points host-provided and have `AuthHost` require them in `RIn`?
