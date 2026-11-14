# @awthaq/test

## 0.2.0

### Minor Changes

- d7351b7: `runPluginContractTests` checks a plugin's own hook taps (PV-260, BEH-EA-200).
  
  - `plugin.taps` entries (`AuthPlugin.DeclaredTap`) now carry, beside `point` and `order`, the tap's `kind`, its `owner` (the plugin id), the `handler` itself and `exercise(input)`/`install(owner)` (`HookPoint.TapDeclaration` gained `kind`, `handler` and `exercise`). `exercise` runs the handler against a stub validated against the point's input schema and returns its `Exit`, unfiltered by any point's failure semantics.
  - `runPluginContractTests` always verifies that each declared tap registers at its point under the plugin's id and declared order, and takes an opt-in `hooks: [{ point, input }]` that runs the plugin's actual handlers: an observe tap must not try to abort (`HookAbort`) and must not fail the observed operation, a veto tap may only abort with `HookAbort`, a divert tap must not fail.
  
  Migration: a hand-built `AuthPlugin.Any` may still omit `taps`; code that builds a `DeclaredTap` by hand must supply the new fields (build it from `Point.declareTap(...)` and add `owner`).
- b97c8c2: `users.metadata` and `sessions.ipAddress`/`userAgent` (with `encryptPii`) are declared `SealedColumn`s under the canonical AAD (`users:<id>:metadata`, `sessions:<id>:<field>`). `UserStore.StoredUser.metadata` and `SessionStore.SessionRecord.ipAddress`/`userAgent` are `Option<Sealed<string>>`; `NewUser.metadata` and `NewSession` stay plaintext. `Users` and `Sessions` degrade an unreadable value to absent with an ids-only warning, as before, and an insert hands back what it wrote without decrypting it (BEH-EA-034, BEH-EA-324, ADR-EA-019 rev 1.3). A sweep over the hand-declared core columns, which used to corrupt `users.metadata`, is now correct.
  
  Migration: values sealed under the old `user:<id>:metadata` / `session:<id>:<field>` AADs no longer open (they read as absent); re-enter the data or accept the loss (pre-1.0, ADR-EA-034). A custom `UserStore`/`SessionStore` returns `Sealed.plain(value)` for a plaintext column. `Repositories.UsersRepository`/`SessionsRepository` rows now carry the stored cell; read it through `metadataOf`/`piiOf`. `StoreContract` cases that compare `StoredUser`/`SessionRecord` values open the PII first.
- 9416e17: Provider tokens are sealed under `accounts:<id>:<field>`, which binds the account: a token copied to another account of the same user and provider no longer opens. `AccountStore.readProviderTokens` returns `Option<Option<SealedProviderTokens>>`, and `Accounts.findProviderTokens` opens the tokens and fails `ProviderTokensUnreadable` (re-consent) for the one that does not; `ProviderTokensUnreadable.reason` may now be `Malformed`. `TokensRead`, `AccountTokenUndecryptable`, `AccountsRepositoryConfig`, `AccountsRepository.findById`/`listByUser`/`findTokensById` are removed (`findSealedTokensById` replaces the last), `AccountsRepository.insert` returns the row as stored, and `writeTokens` is one statement (ADR-EA-019 rev 1.3, BEH-EA-034).
  
  Migration: tokens sealed under `<providerId>:<userId>:<field>` no longer open, so the account needs one OAuth sign-in to re-store them (`OAuthTokenUnavailable` until then). Use `SealedColumnConfig.resealOnRead` instead of `AccountsRepositoryConfig.reencryptOnRead`. A custom `AccountStore` returns sealed tokens (`Sealed.plain` for plaintext) and passes `StoreContract.accounts`.
- fe9dc94: Sign-in completion is one core module, `SignIn` (BEH-EA-322, ADR-EA-038). Every first factor (password, passkey, OAuth, SAML, device authorization, magic link, email OTP) and the second factor now finish through it: `clear` returns a branded `Clearance` (user lookup, suspension gate, `BeforeSignIn`, `BeforeSessionIssue`), `issue` is the only way to mint a session from it, `complete` is both, and `resume` is the divert owner's entry.
  
  - A suspended account's refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy, not only password.
  - A SAML sign-in completed by a second factor now keeps `fed` in its `amr`, is recorded for Single Logout, is role-mapped, and keeps its connection's tenant: the SAML Single Logout record and role mapping are a sign-in continuation (`SignIn.continuation`) that crosses the divert.
  - A user erased between credential proof and session issue is refused with the flow's own uniform error (OAuth: `OAuthCallbackFailed`; SAML: `SamlAssertionRejected`; password and passkey: `InvalidCredentials`) instead of a 500.
  - `Hooks.BeforeSessionIssue`'s input now always carries `amr` (required) and may carry a `handoff` (`{ tenantId?, continuation? }`); the second-factor challenge stores it.
  - `@awthaq/test` gains `SignInProbe`, recording taps for the sign-in and sign-up hook points.
  
  Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the sign-in itself must return the `handoff` it received to `SignIn.resume`. A detector counting `signInFailed` gains suspended refusals from every strategy. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or `clear`/`issue`), never `Sessions.issue`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 2dff755: `FederatedIdentity.make` resolves an external party's assertion to a local user (`resolve`: linked, auto-linked or created through `SignUp`; `attach`: an explicit link), deciding the email-linking policy once and resolving a lost race to the account the winner wrote (ADR-EA-043, BEH-EA-338). New event `auth.account.linked` (`userId`, `providerId`, `via`). `@awthaq/test` gains `Rendezvous` for tests that force an interleaving.
- 8fda479: `AuthEvents.emit(definition, input)` publishes any declared event through its definition (ADR-EA-049): `_tag` is filled in, brands are enforced, and the event gets the same envelope, audit row (actor column, declared personal data recorded with the row) and ADR-EA-037 lane (from the definition's `attempt`) as `publish`, which keeps core's events. The bus carries every event of the composition: `stream` and `subscribe` yield `AuthEvents.PublishedAny`, narrowed by the new validating guard `AuthEvents.is(tag | definition | [...])` (a definition matches only when its schema accepts the event). `on` and `onBatch` take core tags and/or definitions, mixed, with the handler typed exactly. `AuthEvents.UndeclaredEventPolicy` (`"warn"` by default: logged as `auth.event.undeclared` and counted by `awthaq_event_undeclared_total`; `"die"`: `AuthEvents/UndeclaredEvent`) decides what `emit` does with a definition a composed registry does not declare. `@awthaq/test`'s `RedactionGuard.layerEvents` inspects every published event, a plugin's included.
  
  Migration: `AuthEvents.stream`/`subscribe` yield `PublishedAny`; narrow before reading fields: `Stream.filter(AuthEvents.is("auth.session.issued"))` in place of `Stream.filter((e) => e._tag === "auth.session.issued")`, or `AuthEvents.is(AuthEvents.eventTags)` for every core event. A hand-written `AuthEventsShape` gains `emit`. ADR-EA-049, BEH-EA-102, BEH-EA-103.
- 40c84f1: Plugins declare the events they publish, and `Auth.make` composes them (ADR-EA-049). `AuthPlugin.Service(id, { events })` takes the plugin's event definitions (each made with `EventDefinition.define`), read statically like `userFields`. `Auth.make` composes core's definitions with every composed plugin's into `auth.events` (an `EventDefinition.Registry` typed by the tuple: `Auth.EventsOf<P>`), lists them in `manifest.events` (tag, owner, actor, personal-data fields, attempt), provides them through `auth.eventsLayer` (`AuthEvents.EventRegistry`), and refuses a tag declared twice, core's included, or the reserved `"awthaq.foreignEvent"`, with `Auth/EventTagConflict` naming both owners. `AuthEvents.typed(auth.events)` gives the composition-typed `is`, `subscribe` and `on(tag, handler)`. `AuthHost.layer` provides `auth.eventsLayer` (so `TestAuth.layer` does), and `TestAuth.layer` sets `AuthEvents.UndeclaredEventPolicy` to `"die"`. `awthaq plugin list --events` prints `manifest.events` (text or JSON); config loading and `awthaq doctor` report `Auth/EventTagConflict`, `UndeclaredTableDependency`, `Auth/TenancyDeclarationInvalid`, `Auth/SealedColumnDeclarationInvalid`, `Auth/MigrationDeclarationInvalid` and `UserFieldConflict` as link problems with their code instead of a generic load failure.
  
  Migration: a host that composes without `AuthHost.layer` and serves webhooks, configures Retention rules for plugin tags, or relies on the undeclared-event check provides `auth.eventsLayer` last, like `auth.userFieldsLayer`. A hand-written `Auth.Manifest` gains `events`. ADR-EA-049, BEH-EA-101, BEH-EA-016.
- 76ba2e3: `runPluginContractTests` checks every event a plugin declares (ADR-EA-049), always: `EventDefinition.problems` (the declared tag is the schema's, actor and personal-data fields are the event's, a free-text-looking field is declared `pii` or listed as not personal, the tag is `auth.<namespace>.<event>`, not reserved, not repeated), and a sampled check that blanking the declared personal-data fields still decodes and that the actor is a value the event carries. New option `events: { notPersonal: ["<tag>.<field>"] }` for a free-text-looking field that holds no personal data.
  
  Migration: none required (a plugin that declares no events passes vacuously). ADR-EA-049, BEH-EA-198.
- The `userFields` extension point (SAM-004): a plugin declares typed scalar fields on `users`, and the rest is derived.
  
  - `AuthPlugin.Service` takes `userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`. `Auth.make` generates a `NNNN_<plugin>_add_user_field_<field>` migration per field (`ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable, dialect-neutral), returns the composed `userFields` (typed by `Auth.UserFieldsOf<P>`) and `userFieldsLayer`, and lists them in `manifest.userFields`.
  - `Users.getFields`/`setFields` (validated, `source: "client" | "server"` gated per BEH-EA-048) and the typed `Users.typedFields(auth.userFields)`; `UserFields.client(auth.userFields)` for the browser; `UsersRepository.readFields`/`writeFields` in `@awthaq/sql`.
  - `PATCH /user` accepts `fields` (client-writable fields only: 403 `UserFieldNotWritable` for a `serverOnly` one, 422 `UnknownUserField`/`InvalidUserField`), and `AccountDto` carries `fields`. `TestAuth.layer` provides the registry.
  
  Migration: `AccountDto` now has a required `fields` (`{}` when none are declared); a hand-built `UsersShape` implements `getFields`/`setFields`; a hand-built `Manifest` has `userFields: []`; provide `auth.userFieldsLayer` to `Users` when a composition declares fields. ADR-EA-035, BEH-EA-040/048.
- 6a28c4d: `Persistence.memory` and `Persistence.sql()` provide the event relay's position, so `EventRelay.layer` and `Webhooks.Webhooks.background()` need nothing else for it; a cursor-store outage is `StoreUnavailable` instead of a defect, and a busy cursor write is retried instead of redelivering the batch (ADR-EA-028). The position only moves forward, so relays sharing a name no longer pull each other back (ADR-EA-030 rev 1.2).
  
  Migration: delete `EventRelay.layerCursorSql` / `EventRelay.layerCursorMemory` and `Repositories.RelayCursorRepositoryLive` from your composition (the bundle provides the store); `EventRelay.RelayCursorStore` is now `RelayCursorStore.RelayCursorStore` from `@awthaq/ports`, and its `set(name, id)` is `advance({ name, lastEventId, at })`. A custom implementation must make `advance` monotonic and pass `StoreContract.relayCursor`.
- 1c0d1a7: `RelayCursorStore` is a store port in `@awthaq/ports` (`get`, a monotonic `advance`, both failing with `StoreUnavailable`), with `layerMemory`; `StoreContract.relayCursor` is the bar for an adapter (ADR-EA-030, ADR-EA-041).
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 28a78b0: Core reads the request context first (ADR-EA-047). `Sessions.issue` records the address and user agent of the request that minted the session from `Api.AuthRequestContext` (an explicit `request` field still wins until the plugins stop passing one), so admin impersonation sessions now record the administrator's address and user agent; a migrated legacy session keeps its own facts. The `ip` rate-limit strategy keys on the request context's address when the call passes none. `SignIn.failed` is the one publisher of `auth.user.signInFailed`, its `clientIp` read from the context. `TestAuth` gains `withRequest`, `withoutRequest`, a `clientAddress` option, `app(…, { request })` (`run` answers no request by default) and `signInAs({ request })`.
  
  Migration: `Sessions.MAX_USER_AGENT_LENGTH` becomes `Api.MAX_USER_AGENT_LENGTH`. A custom `RateLimits.Key.KeyContext` now carries `request` (`Api.AuthRequestContext.noRequest` when there is none).
- 0e74d59: The request context is required by core (ADR-EA-047). `Sessions.issue` takes no `request` and requires `Api.AuthRequestContext`, recording the facts of the request that minted the session (none under `noRequest`); `SignIn.clear`, `resume`, `issue`, `complete` and `failed` and `SignUp.createSignedIn` take no request facts and require it too; `SignIn.SessionRequest` is gone. `Admin.impersonate` requires it (the impersonation session records the administrator's request). `TestAuth.signInAs` provides it itself.
  
  Migration: drop `request` from `Sessions.issue` calls and the second argument of `SignIn.issue`/`complete` and the third of `SignUp.createSignedIn`; provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest` for a job, `RequestContext.capture(request)` on a host route, `TestAuth.withRequest`/`withoutRequest` in a test).
- 91f219f: Two concurrent ACS requests for one new NameID no longer answer 500 (or reject the second); the second signs in as the user the first created or linked (BEH-EA-245). `@awthaq/test` gains `Rendezvous` for tests that force an interleaving.
- 0304c39: `@awthaq/sql` gains the plugin-table substrate (plan 05): `TenantScoped`, `SealedColumn` and `StoreFailure`, and `TenantScope` learns plugin tables.
  
  - `TenantScoped`: the tenancy kinds (`partitioned`, `keyed`, `derived`, `global`), one index-friendly predicate and one memory matcher for the same rule, and the `CrossTenant` witness (`crossTenant(reason)`) whose `lift` clears `awthaq.tenant_id` for one statement inside an RLS transaction. The stamp rule is `Tenant.stamp` in `@awthaq/ports`; `Repositories` no longer carries a private copy.
  - `SealedColumn`: declare an encrypted column once, get a `Sealed<A>` whose `open` is the only place the plaintext appears, the canonical AAD `<table>:<rowKey>:<column>`, lazy re-seal by compare-and-swap, a typed `SealedColumn/Unreadable` handled by `orDie` or `option`, and a `sweep` batch job. Core's PII and account-token codecs now run on `SealedColumn.reveal` with unchanged behaviour.
  - `StoreFailure`: `storeUnavailable`, `orStoreUnavailable`, `retryTransient` moved here from `@awthaq/core`'s `Errors` (which re-exports them). `@awthaq/sql` now depends on `@awthaq/api`.
  - `TenantScope.enableRls` takes `{ plugins, includeKeyed }`; `disableRls` removes the `awthaq_tenant` policy from every table that has one; `withTenant` marks the RLS scope for `lift`.
  - `@awthaq/server`: a credential-resolver contribution's `StoreUnavailable` is recorded as the request's outage, like the cookie scheme's.
  - `@awthaq/test`: `TestAuth.runTenantIsolationTests` and `TestAuth.runSealedColumnTests`.
  
  Migration: `TenantScope.disableRls` now removes the policy from every table that has one, not only the core tables. `Errors.storeUnavailable` now dies (`Defects/InvariantViolation`, `store.statementRefused`) on a SQL syntax or authorization error instead of answering 503 (ADR-EA-028). BEH-EA-324..327.
- 1cef4be: `StoreContract` takes `RecordsContract`'s shape (architecture plan 37, ADR-EA-041 rev 1.6). Every core store port is a suite whose operations carry verdicts, and one without a verdict does not compile. `StoreContract.run(framework, mode)` owns the memory, SQL and sealed modes. `RateLimiterStore` joins as `rateLimiterStore`.
  
  Migration: `StoreContract.<port>` is a `Suite`, not a `ReadonlyArray` of cases. `StoreContract.run(framework, { adapter, layer, cases })` is now `StoreContract.runSuite(framework, { adapter, suite, layer })`, and `StoreContract.run(framework, mode)` runs every suite on a mode's shipped adapters. A caller that ran the core contract on its own adapter passes the port's suite.
- e3cf8fe: `Accounts` is written once, over a new `AccountStore` port (ADR-EA-041, plan 02 phase 4).
  
  - `@awthaq/ports` gains `AccountStore` (`insertIfAbsent`, the token-free identity reads `get`/`getByKey`/`listByUser`, `readCredentialHash`, `readProviderTokens`, `writeCredentialHash`, `writeProviderTokens`, `deleteUnlessLast`, `deleteByUser`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `AccountStoreSql.layer` over `AccountsRepository`. `@awthaq/core`'s `Accounts` gains `layer` (requires `AccountStore` and `Crypto`); `ProviderTokenSet` is now the port's `ProviderTokens`; `Accounts.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
  - `@awthaq/test` gains `StoreContract.accounts`, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters, with the concurrent-unlink case that proves BEH-EA-045.
  - Behaviour, in every backend: an `issuer` of `""` and an absent issuer are the same (`Option.none()` in the record; memory returned `Some("")`); `listByUser` is ordered by `(createdAt, id)`; `updateCredentialHash` and `updateProviderTokens` bump `updatedAt` (memory did not); an identity read (`findById`, `findByProviderSubject`, `listByUser`, `findCredentialHash`) decrypts no token and never writes a re-encrypted one back (the SQL read decrypted all three token columns and could write on the sign-in path); a duplicate `link` no longer aborts an enclosing Postgres transaction; the memory adapter stamps the ambient tenant.
  - `Accounts.layerSql` now needs `Crypto` (the service mints the account id, like `Sessions` and `Verification`; the SQL model used to).
  - `@awthaq/sql` repository: new `findIdentityById`, `findIdentityByKey`, `listIdentitiesByUser`, `insertIdentityIfAbsent`, `findPasswordHash`, `writePasswordHash`, `writeTokens`; `deleteAllByUser` resolves to the number deleted.
  
  Migration: provide `Crypto` (for example `NodeCrypto.layer`) to a composition that uses `Accounts.layerSql`; it already has it if it also uses `Sessions` or `Verification`. A caller that compared `AccountRecord.issuer` with `Option.some("")` reads `Option.none()` now. BEH-EA-043, BEH-EA-045, BEH-EA-125.
- 896a1de: `AuditLog` is written once, over a new `AuditLogStore` port (ADR-EA-041, plan 02 phase 2).
  
  - `@awthaq/ports` gains `AuditLogStore` (`append`, `select`, `pageAfter`, `rewriteReferencing`, `deleteBefore`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `AuditLogStoreSql.layer` over `AuditLogRepository`. `@awthaq/core`'s `AuditLog` gains `layer` (requires only `AuditLogStore`); `AuditLog.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
  - `@awthaq/test` gains `StoreContract.auditLog`, the cases an `AuditLogStore` adapter must pass, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
  - Behaviour (every backend, identically): recording an event whose `eventId` is already stored is ignored instead of failing (it was an unhandled `UniqueViolation`, reported as `StoreUnavailable`, on SQL); `list` decodes only the rows its filter selects, so one undecodable row no longer fails every listing (memory); `replay` pages in byte order of `id` (Postgres `COLLATE "C"`); `pseudonymizeActor` is all-or-nothing and takes the rows `FOR UPDATE` on Postgres; `purge` with an empty `eventTags` allow-list deletes nothing (it failed on Postgres); `replay` dies on a `batchSize` that is not a positive integer.
  - `@awthaq/sql` repository: `AuditLogRepository.insert` is replaced by `insertIfAbsent` (idempotent on `id`, answers `boolean`), and the `payload` is the JSON text (the row model no longer decodes it), as is the argument of `rewrite`; `listReferencing` takes an optional `{ lock }`.
  
  Migration: an application that calls `AuditLog.record` twice with one event no longer sees an error. A host that reads `AuditLogRepository` directly passes and receives `payload` as JSON text and calls `insertIfAbsent`. `AuditLog.purge({ eventTags })` still takes any array; an empty one now means "no tag", not an error. BEH-EA-100, BEH-EA-102.
- 1c01e7f: Breaking (pre-1.0, ADR-EA-034 section 2): the twin layers are removed in favour of two matched persistence bundles (ADR-EA-041, ADR-EA-014 rev 1.3, plan 02 phase 7).
  
  - `@awthaq/core` gains `Persistence`: `Persistence.memory` (the five `Ref` store adapters plus `SqlTransaction.layerNoop`) and `Persistence.sql({ encryptPii? })` (the five SQL store adapters over the ambient `SqlClient`, the six repositories they need, and `SqlTransaction.layerSql`; it requires `SqlClient | Encryption`).
  - `Users`, `Accounts`, `Sessions`, `Verification` and `AuditLog` lose `layerMemory` and `layerSql`; `X.layer` is the only layer and reads its store from the bundle. `@awthaq/test` gains `TestEncryption.layer` (a fixed-key `Encryption` for SQL test compositions), and `TestAuth` composes `Persistence.memory`.
  
  Migration: `Users.layerMemory`, `Accounts.layerMemory`, `Sessions.layerMemory`, `Verification.layerMemory`, `AuditLog.layerMemory` and their `layerSql` twins are removed. Use `X.layer` and provide `Persistence.memory` (tests, single process) or `Persistence.sql({ encryptPii? })` (production) once. `Persistence.sql()` includes `SqlTransaction.layerSql`, so remove your own. The six `Repositories.*Live` layers no longer need to be assembled by hand. `Repositories.SessionsRepository.markReused` is replaced by `markReusedOnce`. See ADR-EA-041, ADR-EA-014 rev 1.3 and BEH-EA-035/053/054/062/231.
- 2f1b966: `Sessions` is written once, over a new `SessionStore` port (ADR-EA-041, ADR-EA-014, plan 02 phase 6).
  
  - `@awthaq/ports` gains `SessionStore` (`insert`, `get`, `rotate`, `flagReuse`, `remove`, `removeForUser`, `listLive`, `reauthenticate`, `purgeExpired`, each atomic by contract) with a `Ref` adapter, `layerMemory`, and the shared `isLive`, `evictionOrder` and `unionMethods`. `@awthaq/sql` gains `SessionStoreSql.layer` over `SessionsRepository` and `ReadRouting.captureTokenOn`. `@awthaq/core`'s `Sessions` gains `layer` (requires `SessionStore`, `Crypto` and `AuthEvents`); `Sessions.layerMemory` and `layerSql` stay as aliases until the persistence bundles land. A third-party backend (a KV `SessionStore`, ADR-EA-014) implements the nine primitives and passes `StoreContract.sessions`.
  - `@awthaq/test` gains `StoreContract.sessions`, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
  - Behaviour, in every backend: a rotation never touches a tombstoned row, and a call that loses its compare-and-swap re-applies liveness to the row it finds (it used to authenticate whatever was there); `list` is bounded by `LIST_LIMIT` in memory too (it was unbounded); the SQL adapter's session writes capture the replica causal token, so a revoke followed by an eventual device list is read-your-writes; a memory composition prunes an expired row once its map is large, so such a row is `SessionNotFound` rather than `SessionExpired`.
  - `@awthaq/sql` repository: `deleteAllForUserExcept` and `deleteAllByUser` resolve to the number deleted, `touch` refuses a tombstoned row, `listLiveIds` answers branded ids.
  
  Migration: none for application code; `Sessions.list`'s `options` type is `Store.ReadOptions` from `@awthaq/ports` (the same shape, so `ReadRouting.ReadOptions` still works). BEH-EA-052, BEH-EA-053, BEH-EA-054.
- b4ab289: The substrate of the domain store seam (ADR-EA-041), with no behaviour change.
  
  - `@awthaq/ports` gains `Ids` (the `UserId`, `AccountId`, `SessionId`, `VerificationTokenId` and `E164` brands, moved down from `@awthaq/sql`), `Store` (`StoreUnavailable`, `Consistency`, `ReadOptions`), `PruneExpired` (the in-memory eviction, moved from core) and `Tenant.resolve` (the tenant-stamp rule over an optional explicit tenant). It now depends on `@awthaq/api`.
  - `@awthaq/sql` re-exports the id brands and `Consistency`/`ReadOptions` (so `SqlModels.UserId` and `ReadRouting.ReadOptions` keep compiling) and gains `SqlStore` (`write`, `read` and `drainBatches`, the wrapper every SQL store adapter runs a primitive through).
  - `@awthaq/test` gains `StoreContract` (`Case`, `run`, `race`): the runner for the contract each store port's adapters must pass.
  
  Migration: none.
- 2ab9920: `Users` is written once, over a new `UserStore` port (ADR-EA-041, plan 02 phase 5).
  
  - `@awthaq/ports` gains `UserStore` (`insertOrHolder`, `get`/`getByEmail`/`getByPhone`, `updateProfile`, `casIdentity`, `setStatus`, `delete`, `listPage`, `readFields`/`writeFields`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `UserStoreSql.layer` over `UsersRepository`. `@awthaq/core`'s `Users` gains `layer` (provides `Users` and `UserRemoval`; requires `UserStore` and `Crypto`); `Users.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
  - `@awthaq/test` gains `StoreContract.users` (and `StoreContract.userFieldColumns`, the declared-field columns a SQL runner adds to `users`), run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
  - Behaviour, in every backend: `verifyEmail`, `verifyPhone`, `promoteIdentity` and `changeEmail` are a compare-and-swap of the identity columns retried on a concurrent change (three attempts, then `StoreUnavailable`), so `AfterUserAttributesChanged` is announced exactly once and a lowering of `emailVerified` is announced from what the change really did (SQL announced from a stale read); `getFields` and `setFields` answer `UnknownUserField`, `UserFieldNotWritable` and `InvalidUserFieldValue` before `UserNotFound` (memory answered `UserNotFound` first); `setFields` bumps `updatedAt` and answers its own post-state from one statement (memory never changed `updatedAt` on any write, and could write fields for a user deleted mid-call); a user and its declared fields are deleted together; a `list` limit is clamped to 1 to 200 (a negative or non-integer limit was a defect or a wrong page); a duplicate `create` no longer aborts an enclosing Postgres transaction; a holder deleted between the two statements of `createOrGet` retries instead of dying.
  - `Users.layerSql` now needs `Crypto` and `SqlClient` (the service mints the user id, like `Sessions` and `Verification`; the SQL model used to).
  - `@awthaq/sql` repository: new `deleteReturning`, `casIdentity` and `writeFieldsReturning`; `updateProfile` and `setStatus` take an optional `updatedAt`.
  
  Migration: provide `Crypto` (for example `NodeCrypto.layer`) to a composition that uses `Users.layerSql`; it already has it if it also uses `Sessions` or `Verification`. A test that read a memory user's `updatedAt` as unchanged after a write now sees it move. BEH-EA-041, BEH-EA-042, BEH-EA-048.
- b4b0de9: `Verification` is written once, over a new `VerificationStore` port (ADR-EA-041, plan 02 phase 3).
  
  - `@awthaq/ports` gains `VerificationStore` (`upsertLive`, `present`, `settle`, `transaction`, `reserve`, `deleteByUser`, `purgeExpired`, each atomic by contract) with a `Ref` adapter, `layerMemory`. `@awthaq/sql` gains `VerificationStoreSql.layer` over the token and reservation repositories. `@awthaq/core`'s `Verification` gains `layer` (requires `VerificationStore`, `Crypto` and `AuthEvents`); `Verification.layerMemory` and `layerSql` stay as aliases until the persistence bundles land.
  - `@awthaq/test` gains `StoreContract.verification`, run on the `Ref`, SQLite, SQLite WAL file and (`pnpm test:pg`) Postgres adapters.
  - Behaviour, in every backend: a consumed token is kept as replay evidence in memory too (it was deleted there) until `purgeExpired` passes it; a token's payload is JSON text encoded once by the service, so a value JSON cannot carry (a `bigint`, a cycle) is a defect everywhere and a `DateTime` or class instance comes back in its JSON form everywhere (memory returned the object itself); the memory adapter stamps the ambient tenant on tokens and reservations like SQL.
  - `@awthaq/sql` repositories: `VerificationToken.payload` is the JSON text (the model no longer decodes it, `"null"` when there is none), `VerificationRepository.upsertLive` takes it as a string, and `deleteAllByUser` resolves to the number of rows deleted.
  
  Migration: a host that reads `VerificationRepository` or the `VerificationToken` model directly handles `payload` as JSON text. A caller that passed a payload with a non-JSON value (a `DateTime`, a `bigint`) to `Verification.issue` and relied on memory returning it by reference now gets its JSON form (or a defect); pass JSON-encodable values. BEH-EA-061, BEH-EA-062, BEH-EA-122.
- 1cef4be: `TestAuth.app` and `App.dispose` are removed. An app is acquired only through `TestAuth.serve`, `withApp`, `lazyApp` or `listen`, so it cannot outlive the scope that served it (BEH-EA-351).
  
  Migration: inside `it.effect`, `const app = yield* TestAuth.serve(layer, options)` (the test's scope releases it); in an async test, `await TestAuth.withApp(layer, options, async (app) => …)`; a World holds `TestAuth.lazyApp(...)`; a socket server is `TestAuth.listen(...)`.
- f026b29: `TestAuth.app(...).agent()` and `signIn(email)` return user agents (`@awthaq/web`'s `UserAgent`) that keep cookies, echo CSRF from a seeded `__Host-csrf` and follow rotations; `signIn` renders the minted session under the composition's own `SessionCookieConfig`, so a `SecureDomain` composition signs in under `__Secure-session; Domain=…` (it was handed `__Host-session` and answered 401). `signIn({ delivery: "bearer" })` holds the token instead. `request` is a fresh anonymous agent per call; a forged cookie goes in `extraCookies`. Under `testClock`, agents read the composition's clock, so a cookie's `Max-Age` lapses with `advance`. `signInAs` returns the rendered `setCookie`. `CookieAssertions` reads `Set-Cookie` with `@awthaq/web`'s parser (its own `parseSetCookie` is gone) and `assertHostPrefixedCookie` also takes a cookie an agent holds. `@awthaq/test` depends on `@awthaq/web` and re-exports `UserAgent`.
  
  Migration: `const { cookieHeader } = await app.signIn(e); app.request(m, p, { cookie: cookieHeader })` → `const alice = await app.signIn(e); alice.request(m, p)`; `app.agent()` is async (`await app.agent()`); a forged cookie → `extraCookies`; `signInAs(...).cookieHeader` → `setCookie` (hand it to `agent.cookies.receive`); `CookieAssertions.parseSetCookie` → `@awthaq/web`'s `parseSetCookie` (or `CookieAssertions.findSetCookie`). A `Set-Cookie` a browser would refuse now fails the request (`onRefused: "record"` for a test about refusals).
  
  `TestAuth.sessionSetCookie(issued)` renders a session issued straight against `Sessions` (an existing user, a second session of one user) as the `Set-Cookie` an agent receives; `TestAuth.csrfSetCookie(secret)` seeds an agent over a hand-wired handler. `SignedInSession.cookieHeader` and `RequestInit.cookie` are removed.
- 81f11ac: `TestAuth.app` hands a World everything it used to build by hand, and `TestAuth.buildContext` builds any layer on the real clock (plan 08 follow-up).
  
  - `app.runtime` (a `ManagedRuntime` over the same composition), `app.memoMap` and `app.context()` (the composition built once on the real clock, for effects run on the caller's own fiber) all resolve against the instances `app.handler` serves from.
  - `TestAuth.app(layer, { testClock: true })` serves the composition over one `TestClock`; `app.advance(duration)` moves it for the handler, `run` and `runtime` alike, and `request` stamps its CSRF pair from that clock. Without the option `advance` rejects.
  - `TestAuth.app(layer, { memoMap })` builds into a memo map the caller owns, so two apps share the instances they have in common.
  - `TestAuth.buildContext(layer, { scope, memoMap? })` builds any layer into a context on the real clock.
  
  Additive: existing `TestAuth.app` callers are unchanged (`App` gains an optional second type parameter, `E`, for `runtime`).
- 1ee69bf: `TestAuth.layer` now also provides `Authentication.PrincipalResolver` (the one its derived middleware uses, or `options.principalResolver`), so a test that calls `Authentication.resolvePrincipal` directly reads it from the composition instead of hand-building `PrincipalResolverLive`.
- 67eb8f4: `TestAuth.layer` is now `AuthHost.layer` over the test ports and the redaction guard (BEH-EA-342), and takes `tier: "all" | "public" | "admin"`. In `records: "sql"` mode the migrations run through `Migrations.apply`, so a drifted ledger refuses the build. A tap passed in `taps` must tap a point the composition declares (it now fails to compile otherwise). The registries (`RateLimits.layer`, `Slots.layer`, `Credentials.CredentialResolversLive`) now come from `AuthHost`'s base rather than the test ports; the composition's output is otherwise the same set of services, plus the core stores of the chosen bundle.
  
  Migration: none for callers that already compile. A suite whose `taps` tapped an undeclared point (it never ran) must compose the plugin that owns the point; a helper that typed `taps` as `Layer.Layer<never, never, unknown>` should make the requirement a type parameter (see `packages/password/test/harness.ts`).
- 40a32a1: A plugin declares its record stores and its hook points, and `TestAuth.layer` stands a whole composition up from `Auth.make(...)` alone.
  
  - `@awthaq/core`: `AuthPlugin.Service` accepts `records: { memory, sql }` (two matched layers providing the plugin's `/records/` stores, and nothing else) and `hookPoints` (the default layers of the hook points the plugin owns). Both are static members of the class (`Layer.empty` when absent); `AuthPlugin.layer` refuses, at compile time, a layer that requires a `/records/` store no bundle (its own or a `dependsOn` plugin's) provides, a `memory` and `sql` that differ, and a non-core hook point nothing declares. `Auth.Built` gains `plugins`, the tuple as given.
  - `@awthaq/server`: `AuthHttp.middlewareFor(api, { csrf, principalResolver? })` (`csrf` may be `Csrf.layerConfig`: its `ConfigError` joins the layer's error channel) builds exactly the host middleware (`Authentication`, `OptionalAuthentication`, `MachineAuthentication`, `AdminAuthentication`, `CsrfProtection`) the groups of an api declare; `DeclaredMiddleware` is its type.
  - `@awthaq/test`: `TestAuth.layer(built, options)` derives that middleware, selects every composed plugin's records bundle and hook points, merges `options.services` into the output (a service only `services` provides is now really present), and runs over memory (default) or a migrated database (`records: "sql", suite`). New: `TestAuth.app` (handler, `run`, a CSRF-aware `request`, `signIn`, `dispose`; `baseUrl` sets the origin it addresses), `csrfToken`, `TestCsrfConfig`, `httpClient.{noBreach,returning,unavailable}`, `encryption`, `recordModes`, `throwingFramework`, `TestSql` (moved from `packages/sql/test/support`).
  
  Migration: `TestAuth.layer(built, services, opts)` becomes `TestAuth.layer(built, { services, ...opts })`; drop `Authentication.AuthenticationLive`, `Csrf.CsrfProtectionLive`, a `CsrfConfig` and a `CredentialResolversLive` from `services` (the harness provides them; `options.csrf` tunes the config). `import * as TestSql from "../../sql/test/support/TestSql.ts"` becomes `import { TestSql } from "@awthaq/test"`. A plugin that owns hook points adds `hookPoints: <its merged point layer>`; a hand-built layer that taps a non-core hook point it does not own declares it too. BEH-EA-193.
- c3cebf0: `runPluginContractTests` checks a plugin's records bundle and no longer needs `host` for a plugin with `dependsOn`.
  
  - `host` defaults to the plugin's transitive `dependsOn` closure (dependencies first), so `{ options: [{}] }` is enough for every plugin; `host: []` still reports `E_PLUGIN_MISSING_DEP`.
  - A plugin that declares `records` is checked to have a matched pair: `records.memory` builds over the memory foundation, `records.sql` builds over a SQLite database migrated with core and the composition's migrations, and both hold the same service keys (a failure names the extra or missing keys).
  - New opt-in `build: { services }`: the composition is built through `TestAuth.layer` over memory and over SQL, which catches a plugin that composes over memory but not SQL.
  - `TestAuth.throwingFramework(describe, it)` replaces the hand-written `TestFramework` adaptor.
  - `TestAuth.layer`'s base now provides `AuditChain` (needs only `Crypto`), which `Admin`'s impersonation records read.
  
  Migration: none required. A plugin whose bundles disagree now fails its contract test. A new `pnpm check:contract-tests` (part of `pnpm check`) fails when a plugin class has no `runPluginContractTests` call in its package's `test/Contract.test.ts`, or when a library `src` imports `@awthaq/test` or a package lists it under `dependencies`.
- 1cef4be: Test observation leaves the production ports (ADR-EA-054, BEH-EA-354).
  
  - `@awthaq/ports`: `MailerShape` and `SmsSenderShape` are `send` plus the optional `development` flag; `sent` is removed. `Mailer.layerMemory` and `SmsSender.layerMemory` are removed. `layerConsole` logs each message and no longer keeps it.
  - `@awthaq/test`: `TestMailbox` (`layer`, `Mailbox`, `secret`) records every mail and SMS; `Mailbox.mail.waitFor` waits for a matching message by subscription with a real-clock deadline, `refute` fails if one arrives within a window. `TestAuth.layer` provides it in place of `Mailer.layerMemory`; its output now also holds `SmsSender` and `TestMailbox.Mailbox`.
  - `@awthaq/cli`: the `mailer-development` finding names `layerNoop`, `layerConsole` or a test mailbox.
  
  Migration: a provider adapter drops `sent` (`Mailer.Mailer.of({ send })`; the same for `SmsSender`). A test that composed `Mailer.layerMemory` composes `TestMailbox.layer` from `@awthaq/test` (or `Mailer.layerNoop` when nothing is sent) and reads `TestMailbox.Mailbox` instead of `mailer.sent`: `waitFor({ to, template })` replaces a read after cooperative yields, `refute` replaces a "nothing was sent" read, `TestMailbox.secret(mail)` replaces unwrapping `data.token`. A double that only fails or never answers is `Layer.mock(Mailer.Mailer)({ send })`.
- 50c5fe7: `RecordsContract.pending` is removed (plan 25 ticket 25, BEH-EA-336): every shipped plugin record store now has its `RecordsContract` suite, so `RunConfig.suites` takes the suites only. `pnpm check:contract-tests` reports any test file that still names `RecordsContract.pending`.
  
  Migration: a third-party plugin that passed `records: { suite, suites: RecordsContract.pending("<ticket>") }` to `runPluginContractTests` must pass one `RecordsContract.suite(Store, { operations })` per store its bundle provides, keyed by the store's `/records/` key.
- bad8fbd: New `RecordsContract` (plan 25, ADR-EA-041 decision 9): the record-store contract, the plugin-side twin of `StoreContract`. A plugin writes one `RecordsContract.suite(Store, { operations, sql?, tenancy? })` per record store; every operation of the store's interface carries a verdict (`read`, `write`, `atomic` with at least one `race` case, or `exempt` with a reason), so an operation added without one does not compile. `RecordsContract.run` reads the adapters from `Plugin.records`, runs every case on memory and on SQL (SQLite `:memory:`, a Postgres schema under `AWTHAQ_POSTGRES_URL`) with a fresh adapter per case, checks that every store the bundle provides has a suite, and runs a suite's tenancy cases through `runTenantIsolationTests` over the same adapters. `runPluginContractTests` gains a `records` option: required by the compiler when the plugin's bundle provides a store (`RecordsContract.Suites<P>` names every key), forbidden when it provides none, optional for a hand-built `AuthPlugin.Any`. `RecordsContract.pending(ticket)` stands in for a plugin whose suites are not written yet. `pnpm check:contract-tests` now also fails when a `Contract.test.ts` that passes `records` is missing from `scripts/test-pg.sh`.
  
  Migration: `runPluginContractTests` requires `records: { suite, suites }` for a plugin whose `records` bundle provides a store; write one `RecordsContract.suite` per store (see docs/plugin-authoring.md), or pass `suites: RecordsContract.pending("<ticket>")` until you do.
- 1cef4be: `TestAuth.serve` and `TestAuth.withApp` serve a composition for as long as the caller's scope (or callback) is open and release everything it built (BEH-EA-351). `testClock: "now"` starts the simulated clock at the wall clock. `TestAuth.lazyApp` is a World's one lazy app cell (BEH-EA-352). `TestAuth.listen` also binds the app to `127.0.0.1` on an ephemeral port and logs the socket's requests (BEH-EA-353). `TestAuth.openApps` and `TestSql.openClients` count what is still open. `TestAuth.app` is now deprecated.
  
  Migration: none yet; `TestAuth.app` keeps working (its `dispose` is unchanged) until a later release removes it.

### Patch Changes

- 85c9e47: `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  
  Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` -> `Credentials.*` (same names; `Authentication.CredentialCarrier` is `Credentials.ClaimCarrier`). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` -> `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.
- 2babe84: `PasswordCredential` (exposed by `Password.layer`, ADR-EA-040, key `awthaq/plugin/password/Credential`) is the one module that verifies a password against the stored credential: `verify` resolves the claimant, reads its password credential and runs exactly one real verify (against the boot-time dummy hash when there is none), the whole effect held to the timing floor in force; `rehashIfStale` upgrades the credential on the branded `Proof` only `verify` mints. `accept` is the one policy (minimum length, breach screening, per-tenant overrides) and mints the branded `Accepted` every write takes; `linkFor` hashes an accepted password for the sign-up unit; `set` replaces or links the credential and `replace` rewrites an existing one, never linking one (both inside the caller's unit of work, the KDF at most once and only once a write is certain), and `has` answers whether there is one. Sign-up, reset and change accept through it; `signIn`, `changePassword` and `reauthenticate` verify through it, so the timing floor now covers the account lookup of the last two as well as their verify. `changePassword` now commits the new hash, the revocation of the caller's other sessions and the rotated session as one unit, and its transaction failing is `StoreUnavailable` (503).
  
  `@awthaq/test`: `StoreContract.accounts` gains the case "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable"; its cases now require `SqlTransaction` (the `Ref` runner provides `SqlTransaction.layerNoop`).
  
  Migration: none in the API. `Password.config`, `Password.PasswordConfig` and `Password.PasswordConfigShape` are unchanged; they now live in `PasswordConfig.ts` and are re-exported. A host whose layer type is emitted in a declaration file must name the exposed service, or TypeScript reports TS2883: add `export type PasswordServices = PasswordCredential.PasswordCredential` beside the layer, as the examples do.
- 9a04906: Postgres: racing session inserts and step-ups no longer overshoot or exhaust under contention, and a domain claim's writes stay under row-level security.
  
  - `@awthaq/sql`: `SessionStore.insert` with a `maxLive` cap takes a per-user advisory transaction lock, so concurrent logins serialize and the cap holds exactly (SMS-003); `SessionStore.reauthenticate` takes a per-session lock, so N concurrent step-ups all land (THS-003).
  - `@awthaq/organization`: `DomainClaims.claim` lifts row-level security only for the owner read, not for its inserts and deletes.
  - `@awthaq/test`: `TestSql.prepareRlsProbe` readies a suite's schema for an RLS probe; `runTenantIsolationTests` uses it.
- 7e9834e: Plugins contribute their own retention rules to `Retention.sweep`.
  
  - `@awthaq/core`: new `Retention.contribute({ id, order?, make })` and `Retention.RetentionRegistry` (provided by `Hooks.HooksLive`, like the erasure registry). `Retention.sweep` runs every contribution after the core purges, isolates a failing one, and reports `SweepReport.plugins: ReadonlyArray<{ id, deleted, failed }>`; its requirements gain `RetentionRegistry`. ADR-EA-031 Decision 6 amended (revision 1.4); BEH-EA-337.
  - `@awthaq/saml`: contributes `saml.sessions` and no longer prunes session records inside every sign-in.
  - `@awthaq/device-authorization`: contributes `device_authorization.grants`. `@awthaq/jwt`: contributes `jwt.revocations` (`RevocationStore` gains `purgeExpired`). `@awthaq/organization`: contributes `organization.invitations` (new `invitationRetention`, default 30 days; `InvitationRecords` gains `purgeExpired`). `@awthaq/passkey`: contributes `passkey.challenges`. `@awthaq/webhooks`: contributes `webhooks.deliveries` (the worker keeps its hourly prune).
  
  Migration: a composition that installs one of these plugins must provide `Retention.RetentionRegistry`; every `Auth.make` composition and `Hooks.HooksLive` already do. A host with its own `RevocationStore` or `InvitationRecords` implements `purgeExpired`. SAML session records now age out only when the host runs `Retention.sweep` or `Retention.layerScheduled`; a host that relied on the inline prune must schedule the sweep.
- a232d8e: `SessionDelivery.respond(request, mint)` is the one call a session-minting handler makes: it validates `X-Awthaq-Token-Delivery`, runs `mint` only after that, then delivers the session as a cookie or a bearer body (plan 01 phase 6).
  
  - `@awthaq/server`: adds `SessionDelivery.respond`; `AuthHttp.coreHandlers` logs one warning at layer build when `RequestContext.layer` is not merged on the router (sessions would record no address or user agent), silenced by providing `RequestContext.warnWhenAbsent` as `false`; `RequestContext.layer` stays opt-in. `README.md` documents both.
  - `@awthaq/password`, `@awthaq/two-factor`, `@awthaq/magic-link`, `@awthaq/passkey`: every handler that mints a session goes through `respond`; behaviour on the wire is unchanged (a concealed sign-up still refuses a bad delivery header first).
  - `@awthaq/test`: `TestAuth` silences the new warning, since the in-process harness serves without `RequestContext.layer`.
- 1cef4be: `StoreContract.verification` states the give-back (ADR-EA-039) on every adapter: a hold given back after its caller's transaction failed is live again, and a newer `upsertLive` or a `deleteByUser` in between wins. A store whose `settle` ignores `"returned"` now fails the contract.
- Updated dependencies
- Updated dependencies [a95959c]
- Updated dependencies [89fb48c]
- Updated dependencies [09d61ca]
- Updated dependencies [f810dcd]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [d7351b7]
- Updated dependencies [b97c8c2]
- Updated dependencies [9416e17]
- Updated dependencies [fe9dc94]
- Updated dependencies [2706762]
- Updated dependencies [50a23f8]
- Updated dependencies [85c9e47]
- Updated dependencies [8dd72b6]
- Updated dependencies [1cef4be]
- Updated dependencies [2c3c400]
- Updated dependencies [3514b28]
- Updated dependencies [349acb4]
- Updated dependencies [cb155d4]
- Updated dependencies [3b99770]
- Updated dependencies [14bc1bc]
- Updated dependencies [2dff755]
- Updated dependencies [f831b6c]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [bb72df5]
- Updated dependencies [6070f7f]
- Updated dependencies [e073887]
- Updated dependencies [a305c26]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [f4cf736]
- Updated dependencies [05c2ef7]
- Updated dependencies
- Updated dependencies [7f3f6bf]
- Updated dependencies [273f910]
- Updated dependencies [8eef209]
- Updated dependencies [5a3998d]
- Updated dependencies [8fda479]
- Updated dependencies [40c84f1]
- Updated dependencies [4f65d9e]
- Updated dependencies [6355450]
- Updated dependencies [fcdb168]
- Updated dependencies [f0f2f3e]
- Updated dependencies [2e56459]
- Updated dependencies [ef9846c]
- Updated dependencies [72a2e78]
- Updated dependencies [ae1175d]
- Updated dependencies [161d66c]
- Updated dependencies [d3a548f]
- Updated dependencies [93f2469]
- Updated dependencies [f005a91]
- Updated dependencies [75cc655]
- Updated dependencies [4379a62]
- Updated dependencies [9e6302f]
- Updated dependencies [4688890]
- Updated dependencies [3d00f58]
- Updated dependencies
- Updated dependencies [9a04906]
- Updated dependencies [38ca611]
- Updated dependencies [4d9fed1]
- Updated dependencies [1371d7b]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [6cebb31]
- Updated dependencies [d82b7a4]
- Updated dependencies [28a78b0]
- Updated dependencies [0e74d59]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [71a4af0]
- Updated dependencies [01b82ea]
- Updated dependencies [7dc7f4b]
- Updated dependencies [1a206af]
- Updated dependencies [1cef4be]
- Updated dependencies [401a719]
- Updated dependencies [a232d8e]
- Updated dependencies [fc20f74]
- Updated dependencies [2be1097]
- Updated dependencies [4cd6174]
- Updated dependencies [6a06f06]
- Updated dependencies [6d797b0]
- Updated dependencies [b0b6a4d]
- Updated dependencies [5d5b3c6]
- Updated dependencies [f58b51f]
- Updated dependencies [0304c39]
- Updated dependencies [6b68edc]
- Updated dependencies [cf2742e]
- Updated dependencies [be42578]
- Updated dependencies [0a44931]
- Updated dependencies [ed1ac91]
- Updated dependencies [1141658]
- Updated dependencies [79909fa]
- Updated dependencies [6d3a955]
- Updated dependencies [5f11353]
- Updated dependencies [e3cf8fe]
- Updated dependencies [896a1de]
- Updated dependencies [1c01e7f]
- Updated dependencies [942e1d8]
- Updated dependencies [2f1b966]
- Updated dependencies [b4ab289]
- Updated dependencies [2ab9920]
- Updated dependencies [b4b0de9]
- Updated dependencies [40a32a1]
- Updated dependencies [1cef4be]
- Updated dependencies
- Updated dependencies [e6c3620]
- Updated dependencies [37e5cdd]
- Updated dependencies [c0e7bd9]
- Updated dependencies [020abf8]
- Updated dependencies [b771d36]
- Updated dependencies [9cdebdd]
- Updated dependencies [d8b7f18]
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/web@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/qadi@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
