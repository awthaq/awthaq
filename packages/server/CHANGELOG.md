# @awthaq/server

## 0.2.0

### Minor Changes

- f810dcd: `AuthHost.layer(auth, { persistence, csrf, ... })` turns an `Auth.make` result into the servable layer: routes, core handlers, every plugin's records bundle and hook points, core services and registries, the derived middleware, user fields, `RequestContext` and `BodyLimit`, and in SQL mode the migrations (`migrations: "apply" | "verify"`). Its requirements are exactly the ports and platform services the host owns (ADR-EA-044, BEH-EA-340, BEH-EA-341).
  
  Migration: none required (additive). A hand-built host composition can be replaced by one call; keep your ports, your `SqlClient` and your jobs (`Retention.layerScheduled`, `SecuritySignals.layer`) beside it, and drop `BodyLimit.layer`/`RequestContext.layer` from your own list (or pass `bodyLimit: false` / `requestContext: false`).
- 85c9e47: `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  
  Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` -> `Credentials.*` (same names; `Authentication.CredentialCarrier` is `Credentials.ClaimCarrier`). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` -> `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.
- 8dd72b6: A native client's first sign-in no longer needs the CSRF warm-up: an unsafe request that carries no `Cookie` header at all skips the double-submit pair.
  
  CSRF defends ambient browser credentials, and a request with no `Cookie` header (and no `Authorization`) carries none, so `CsrfProtection` no longer demands the `__Host-csrf` pair of it, which a cookie-less client could only obtain through a warm-up `GET` and a cookie jar. The site checks still run, in a stricter form that guards login CSRF: `Sec-Fetch-Site` must be `same-origin` or `none`; `same-site` is admitted only with an allow-listed `Origin`; `cross-site`, a foreign `Origin` or `Origin: null` are refused; with neither header the caller is a non-browser and is admitted. A request carrying any cookie (a stale session cookie, an analytics cookie) keeps the full double-submit check. `CsrfConfig.requireTokenWithoutCookies: true` withdraws the exemption; `@awthaq/client` adds `CsrfClientNative`, the client half for a program with no cookie jar (no cookie read, no `CsrfRejected` retry). BEH-EA-077 (cookie-less exemption and threat model), BEH-EA-079.
  
  Migration: none required. A deployment that authenticates by an ambient non-cookie credential (mTLS client certificates, an intranet network position, HTTP Basic) or that must cover a browser sending neither `Sec-Fetch-Site` nor `Origin` sets `requireTokenWithoutCookies: true`.
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 40c84f1: Plugins declare the events they publish, and `Auth.make` composes them (ADR-EA-049). `AuthPlugin.Service(id, { events })` takes the plugin's event definitions (each made with `EventDefinition.define`), read statically like `userFields`. `Auth.make` composes core's definitions with every composed plugin's into `auth.events` (an `EventDefinition.Registry` typed by the tuple: `Auth.EventsOf<P>`), lists them in `manifest.events` (tag, owner, actor, personal-data fields, attempt), provides them through `auth.eventsLayer` (`AuthEvents.EventRegistry`), and refuses a tag declared twice, core's included, or the reserved `"awthaq.foreignEvent"`, with `Auth/EventTagConflict` naming both owners. `AuthEvents.typed(auth.events)` gives the composition-typed `is`, `subscribe` and `on(tag, handler)`. `AuthHost.layer` provides `auth.eventsLayer` (so `TestAuth.layer` does), and `TestAuth.layer` sets `AuthEvents.UndeclaredEventPolicy` to `"die"`. `awthaq plugin list --events` prints `manifest.events` (text or JSON); config loading and `awthaq doctor` report `Auth/EventTagConflict`, `UndeclaredTableDependency`, `Auth/TenancyDeclarationInvalid`, `Auth/SealedColumnDeclarationInvalid`, `Auth/MigrationDeclarationInvalid` and `UserFieldConflict` as link problems with their code instead of a generic load failure.
  
  Migration: a host that composes without `AuthHost.layer` and serves webhooks, configures Retention rules for plugin tags, or relies on the undeclared-event check provides `auth.eventsLayer` last, like `auth.userFieldsLayer`. A hand-written `Auth.Manifest` gains `events`. ADR-EA-049, BEH-EA-101, BEH-EA-016.
- The `userFields` extension point (SAM-004): a plugin declares typed scalar fields on `users`, and the rest is derived.
  
  - `AuthPlugin.Service` takes `userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`. `Auth.make` generates a `NNNN_<plugin>_add_user_field_<field>` migration per field (`ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable, dialect-neutral), returns the composed `userFields` (typed by `Auth.UserFieldsOf<P>`) and `userFieldsLayer`, and lists them in `manifest.userFields`.
  - `Users.getFields`/`setFields` (validated, `source: "client" | "server"` gated per BEH-EA-048) and the typed `Users.typedFields(auth.userFields)`; `UserFields.client(auth.userFields)` for the browser; `UsersRepository.readFields`/`writeFields` in `@awthaq/sql`.
  - `PATCH /user` accepts `fields` (client-writable fields only: 403 `UserFieldNotWritable` for a `serverOnly` one, 422 `UnknownUserField`/`InvalidUserField`), and `AccountDto` carries `fields`. `TestAuth.layer` provides the registry.
  
  Migration: `AccountDto` now has a required `fields` (`{}` when none are declared); a hand-built `UsersShape` implements `getFields`/`setFields`; a hand-built `Manifest` has `userFields: []`; provide `auth.userFieldsLayer` to `Users` when a composition declares fields. ADR-EA-035, BEH-EA-040/048.
- 1371d7b: The account data export (`GET /user/export`) rate limit is declared and registered like a plugin's rule, under core's own owner `account` (`RateLimits.owner`, rule `exportData`, 5 per hour per user), and spent through `RateLimits.budget` (plan 06). It appears in `RateLimitsRegistry.registered`; it is not in `Auth.make(...).manifest.rateLimits`, which folds only plugins.
  
  Migration: `AuthHttp.CoreHandlerServices` (and so `AuthHttp.coreHandlers`, `Account.AccountHandlers`) now requires `RateLimits.RateLimitsRegistry`. Every composition that installs a plugin already provides `RateLimits.layer`, and `TestAuth.layer` does; a host that served `coreHandlers` without any plugin adds `RateLimits.layer` once. The export bucket is renamed (`account:export:<userId>` becomes `ratelimit:account.exportData:user:<userId>`), so a deploy resets the live export counters once; entries in a shared store expire within one hour.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 01b82ea: SCIM `DELETE /Users/:id` with `deleteBehavior: "erase"` now runs the account erasure (ADR-EA-031, BEH-EA-250): every plugin's rows (organization memberships and invitations, passkeys, roles, ...), linked accounts, sessions, verification tokens, the user and the audit pseudonymization, in one transaction, announced by `auth.user.deleted` with `deletedBy: "directory"`. It previously deleted only the user row and its sessions, leaving memberships (a taken seat), linked accounts (a SAML sign-in for the same NameID then failed) and the audit trail behind. `@awthaq/scim` also takes part in every erasure (`scimErasure`: the user's `scim_resource` rows) and in the data-subject export (`scimExport`), and adds a `scim_resource(kind, "resourceId")` index migration.
  
  Migration: `AccountErasure.eraseAccount(userId, options?)` is now `eraseAccount(userId, initiator)` with a required `Erasure.ErasureInitiator`: `{ deletedBy: "self" }` becomes `ErasureInitiator.Self()`, `{ deletedBy: "admin" }` becomes `ErasureInitiator.Admin({ adminUserId })`, and a call with no options (which meant "self") becomes `ErasureInitiator.Self()`. `auth.user.deleted.deletedBy` gains `"directory"` and optional `adminUserId`/`connectionId`/`organizationId`: an exhaustive switch on `deletedBy` needs a `"directory"` case. A composition of `Scim.layer` must now provide `Erasure.AccountErasure` (`Erasure.layer`; `AuthHttp` compositions already do). A SCIM `DELETE` racing another erasure of the same user now answers 404 instead of 204. Run the new SCIM migration.
- 1cef4be: `SessionDelivery.redirect` is replaced by `SessionDelivery.land`, which owns the PV-016 landing choice (architecture plan 33).
  
  OAuth's callback answers exactly as before; it now calls `land` instead of building the interstitial itself.
  
  Migration: replace `SessionDelivery.redirect(HttpServerResponse.redirect(url), issued)` with `SessionDelivery.land(url, issued)`; pass `{ bounce: false }` to keep the plain `302` under a `Strict` session cookie, and `undefined` for `issued` to decline `Mints`. ADR-EA-045 revision 1.1.
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.
- a232d8e: `SessionDelivery.respond(request, mint)` is the one call a session-minting handler makes: it validates `X-Awthaq-Token-Delivery`, runs `mint` only after that, then delivers the session as a cookie or a bearer body (plan 01 phase 6).
  
  - `@awthaq/server`: adds `SessionDelivery.respond`; `AuthHttp.coreHandlers` logs one warning at layer build when `RequestContext.layer` is not merged on the router (sessions would record no address or user agent), silenced by providing `RequestContext.warnWhenAbsent` as `false`; `RequestContext.layer` stays opt-in. `README.md` documents both.
  - `@awthaq/password`, `@awthaq/two-factor`, `@awthaq/magic-link`, `@awthaq/passkey`: every handler that mints a session goes through `respond`; behaviour on the wire is unchanged (a concealed sign-up still refuses a bad delivery header first).
  - `@awthaq/test`: `TestAuth` silences the new warning, since the in-process harness serves without `RequestContext.layer`.
- 0304c39: `@awthaq/sql` gains the plugin-table substrate (plan 05): `TenantScoped`, `SealedColumn` and `StoreFailure`, and `TenantScope` learns plugin tables.
  
  - `TenantScoped`: the tenancy kinds (`partitioned`, `keyed`, `derived`, `global`), one index-friendly predicate and one memory matcher for the same rule, and the `CrossTenant` witness (`crossTenant(reason)`) whose `lift` clears `awthaq.tenant_id` for one statement inside an RLS transaction. The stamp rule is `Tenant.stamp` in `@awthaq/ports`; `Repositories` no longer carries a private copy.
  - `SealedColumn`: declare an encrypted column once, get a `Sealed<A>` whose `open` is the only place the plaintext appears, the canonical AAD `<table>:<rowKey>:<column>`, lazy re-seal by compare-and-swap, a typed `SealedColumn/Unreadable` handled by `orDie` or `option`, and a `sweep` batch job. Core's PII and account-token codecs now run on `SealedColumn.reveal` with unchanged behaviour.
  - `StoreFailure`: `storeUnavailable`, `orStoreUnavailable`, `retryTransient` moved here from `@awthaq/core`'s `Errors` (which re-exports them). `@awthaq/sql` now depends on `@awthaq/api`.
  - `TenantScope.enableRls` takes `{ plugins, includeKeyed }`; `disableRls` removes the `awthaq_tenant` policy from every table that has one; `withTenant` marks the RLS scope for `lift`.
  - `@awthaq/server`: a credential-resolver contribution's `StoreUnavailable` is recorded as the request's outage, like the cookie scheme's.
  - `@awthaq/test`: `TestAuth.runTenantIsolationTests` and `TestAuth.runSealedColumnTests`.
  
  Migration: `TenantScope.disableRls` now removes the policy from every table that has one, not only the core tables. `Errors.storeUnavailable` now dies (`Defects/InvariantViolation`, `store.statementRefused`) on a SQL syntax or authorization error instead of answering 503 (ADR-EA-028). BEH-EA-324..327.
- 40a32a1: A plugin declares its record stores and its hook points, and `TestAuth.layer` stands a whole composition up from `Auth.make(...)` alone.
  
  - `@awthaq/core`: `AuthPlugin.Service` accepts `records: { memory, sql }` (two matched layers providing the plugin's `/records/` stores, and nothing else) and `hookPoints` (the default layers of the hook points the plugin owns). Both are static members of the class (`Layer.empty` when absent); `AuthPlugin.layer` refuses, at compile time, a layer that requires a `/records/` store no bundle (its own or a `dependsOn` plugin's) provides, a `memory` and `sql` that differ, and a non-core hook point nothing declares. `Auth.Built` gains `plugins`, the tuple as given.
  - `@awthaq/server`: `AuthHttp.middlewareFor(api, { csrf, principalResolver? })` (`csrf` may be `Csrf.layerConfig`: its `ConfigError` joins the layer's error channel) builds exactly the host middleware (`Authentication`, `OptionalAuthentication`, `MachineAuthentication`, `AdminAuthentication`, `CsrfProtection`) the groups of an api declare; `DeclaredMiddleware` is its type.
  - `@awthaq/test`: `TestAuth.layer(built, options)` derives that middleware, selects every composed plugin's records bundle and hook points, merges `options.services` into the output (a service only `services` provides is now really present), and runs over memory (default) or a migrated database (`records: "sql", suite`). New: `TestAuth.app` (handler, `run`, a CSRF-aware `request`, `signIn`, `dispose`; `baseUrl` sets the origin it addresses), `csrfToken`, `TestCsrfConfig`, `httpClient.{noBreach,returning,unavailable}`, `encryption`, `recordModes`, `throwingFramework`, `TestSql` (moved from `packages/sql/test/support`).
  
  Migration: `TestAuth.layer(built, services, opts)` becomes `TestAuth.layer(built, { services, ...opts })`; drop `Authentication.AuthenticationLive`, `Csrf.CsrfProtectionLive`, a `CsrfConfig` and a `CredentialResolversLive` from `services` (the harness provides them; `options.csrf` tunes the config). `import * as TestSql from "../../sql/test/support/TestSql.ts"` becomes `import { TestSql } from "@awthaq/test"`. A plugin that owns hook points adds `hookPoints: <its merged point layer>`; a hand-built layer that taps a non-core hook point it does not own declares it too. BEH-EA-193.

### Patch Changes

- 89fb48c: API keys and `client_credentials` clients stop authenticating when their owner is suspended, banned, deactivated by SCIM, or erased.
  
  - `@awthaq/api-key`: `ApiKey.resolve` and `ApiKey.issueServiceToken` apply the shared sign-in gate (`Users.assertCanSignIn`) to the key's owner after the secret matched, so a missing or suspended owner is refused like an unknown credential. An outage reading the owner is the typed `StoreUnavailable` (503). The plugin now contributes to `ErasureRegistry` (deletes the user's keys and clients) and to `DataExportRegistry` (names, prefixes and scopes, never a secret or hash); `ApiKeyRecords` and `ApiKeyClientRecords` gain `deleteByOwner`. `ApiKeyShape["resolve"]` and `["issueServiceToken"]` gain `StoreUnavailable` in their error channel and `POST /api-key/token` declares it.
  - `@awthaq/server`: `CredentialResolverContribution.resolve` may fail with `StoreUnavailable`.
  
  Migration: `ApiKey.layer` now requires `Users` and `Erasure.ErasureRegistry`/`DataExport.DataExportRegistry` (all provided by a standard `Auth.make` composition and `Hooks.HooksLive`). A host with a custom `ApiKeyRecords` or `ApiKeyClientRecords` implements `deleteByOwner`. Keys of users erased before this release are now refused; purge the orphans with `DELETE FROM apikey_key WHERE "ownerId" NOT IN (SELECT id FROM users)` (and the same for `apikey_client`). BEH-EA-046.
- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 36951f5: `AuthRequestContext` moves to `@awthaq/api` (beside `CurrentPrincipal`) and becomes a tagged value: `Request { correlationId, ip, userAgent }` or `NoRequest`, with no default. `Api.RequestContext` is the endpoint middleware that will provide it (ADR-EA-047). The user agent is capped at 512 characters by the only constructor of the branded `Api.UserAgentHeader`, so event envelopes and audit rows now carry the same capped value as the session row.
  
  Migration: import `Api.AuthRequestContext` from `@awthaq/api` (the `AuthRequestContext` namespace of `@awthaq/core` is gone); `AuthRequestContext.none` becomes `Api.AuthRequestContext.noRequest`; a value you provide is `Api.AuthRequestContext.request({ correlationId, ip?, userAgent? })`.
- Updated dependencies
- Updated dependencies [a95959c]
- Updated dependencies [09d61ca]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [d7351b7]
- Updated dependencies [b97c8c2]
- Updated dependencies [9416e17]
- Updated dependencies [fe9dc94]
- Updated dependencies [2706762]
- Updated dependencies [50a23f8]
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
- Updated dependencies [401a719]
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
- Updated dependencies [9cdebdd]
  - @awthaq/core@0.2.0
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/sql@0.1.0
