# @awthaq/api-key

## 0.2.0

### Minor Changes

- 8b6d329: API-key rotation and revocation are decided at the record-store write (plan 25 ticket 17, ADR-EA-041 decision 9):
  
  - `ApiKey.rotate` no longer leaves a live successor of a key revoked while it ran. The successor is stored and the predecessor's expiry capped at `now + grace` (never lengthened) in one step, and only while the predecessor is neither revoked nor expired; a revoke that lands after the rotation read the key live wins, and the rotation answers `ApiKeyNotFound` with nothing stored.
  - `ApiKey.revoke` publishes `auth.apiKey.revoked` only from the call that revoked the key: a repeated or concurrent revocation of the same key is a silent no-op (still `204`), so the audit log records one revocation.
  - A reused key or client id is a defect on both adapters (the memory adapter used to overwrite the row; SQL used to answer `StoreUnavailable`).
  - An `apikey_client` insert outage names `ApiKeyClientRecords.insert` in the 503 body, not `ApiKeyClientRecords.previousExpiresAt`.
  
  Migration: a custom adapter through `@awthaq/api-key`'s `ApiKeyRecords` must implement `ApiKeyRecords.rotate({ predecessorId, successor, graceUntil, now })` atomically, answering `"rotated"` or `"notLive"` (memory: one `Ref.modify`; SQL: a conditional `UPDATE … WHERE "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > now) RETURNING id` and the insert in one transaction); `ApiKeyRecords.limitExpiry` is removed (its only caller was `rotate`). Migration: `ApiKeyRecords.revoke` now answers a `boolean`, `true` only for the call that set `revokedAt`. MOD-EA-007, BEH-EA-140, ADR-EA-022.
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 72a2e78: `@awthaq/api-key` owns its events (ADR-EA-049): the six `auth.apiKey.*` definitions moved from `@awthaq/core` to `ApiKeyEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged.
  
  Migration: `AuthEvents.ApiKeyCreatedEvent`, `AuthEvents.ApiKeyRevokedEvent`, `AuthEvents.ApiKeyRotatedEvent`, `AuthEvents.ApiKeyClientRegisteredEvent`, `AuthEvents.ApiKeyClientRevokedEvent` and `AuthEvents.ApiKeyClientSecretRotatedEvent` → `ApiKeyEvents.<same name>` from `@awthaq/api-key`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.apiKey.*`: subscribe with `AuthEvents.on(ApiKeyEvents.ApiKeyCreatedEvent, …)`, narrow the stream with `AuthEvents.is(ApiKeyEvents.ApiKeyCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(ApiKeyEvents.ApiKeyCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(ApiKeyEvents.ApiKeyCreatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 77e05bd: The remaining plugin stores fail with `StoreUnavailable` instead of dying (plan 05, ADR-EA-028).
  
  - `ApiKeyRecords`, `ApiKeyClientRecords`, `DeviceGrantRecords`, `DeviceClientRecords`, `PasskeyCredentials` (`recordUsage` included), `PasskeyUserHandles`, `ChallengeStore`, `Roles` (`assign`, `revoke`, `listRoleNames`, `holders`, `listUnknownAssignments`) and `UserClaims` (`get`, `set`, `merge`, `delete`) answer a database failure with the typed `StoreUnavailable` naming `<Records>.<method>`; the services built on them (`ApiKey`, `DeviceAuthorization`, `Passkey`, `RolesAdmin`) widen their `E` accordingly. All their tables are Global (no tenant column).
  - An API-key service-token resolver and a JWT bearer resolver let an outage through as `StoreUnavailable` (a `503`) instead of answering `401`. `@awthaq/qadi`'s `SubjectResolver.resolve` and its `AuthorizedSubject` middleware may fail with `StoreUnavailable` (a roles lookup that is down is no longer a defect), and `UserClaimsAttributes` / `OrganizationQadi` answer it as their own typed resolve error so the policy engine fails closed.
  
  Migration: handle `StoreUnavailable` on the widened methods; an application that implements `SubjectResolverShape`, `RolesShape`, `ChallengeStoreShape` or one of the records shapes adopts the wider `E`. BEH-EA-325.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- dec8ba9: API keys declare their three rate-limit rules as a `rateLimitRules` table and spend them through `RateLimits.budget` / `RateLimits.budgetOf(ApiKey)` (plan 06). `ApiKeyConfig.tokenRateLimit` and `resolveRateLimit` are unchanged and tune the declared defaults. The registry now reports the keys that are actually enforced (it used to register the per-client rule as the literal `apikey:token:client:[object Object]` and the IP rules as the generic `"ip"`), and any rule can also be tuned with `RateLimits.overrides(RateLimits.tune(ApiKey, { tokenByClient: { limit: 10 } }))`.
  
  Migration: rule labels are renamed (they appear in `auth.rateLimit.exceeded.rule`, the `awthaq.ratelimit.exceeded` metric and `plugin list --rules`): `token-ip` is `tokenByIp`, `token-client` is `tokenByClient` (and reports `dimension: "identity"`, was `"custom"`), `resolve-ip` is `resolveByIp`. Rate-limit buckets are renamed too (`apikey:token:ip:<ip>` becomes `ratelimit:apikey.token.tokenByIp:ip:<ip>`, `apikey:token:client:<id>` becomes `ratelimit:apikey.token.tokenByClient:client:<id>`, `apikey:resolve:ip:<ip>` becomes `ratelimit:apikey.resolveByIp:ip:<ip>`), so a deploy resets the live counters once; entries in a shared store expire within one minute.
- dc8ed7d: `ApiKey.records` is the plugin's key and client stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.
  
  - `ApiKeyRecords` and `ApiKeyClientRecords` are keyed `awthaq/api-key/records/<Name>`; the bundle provides both over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. `CredentialResolvers` stays the composition's registry (a `TestAuth` composition provides it).
  
  Migration: code that built a `Context` by the old key string must use the class. A host replaces the pair of `layerMemory` / `layerSql` layers with `ApiKey.records.memory` / `ApiKey.records.sql`.
- c3c7bd6: `ApiKey` reads no request facts (ADR-EA-047): the token endpoint's `tokenByIp` and the key resolver's `resolveByIp` throttle key on the address of the request context (the resolver receives it through the credential claim), so the plugin layer no longer requires `ClientAddress`.
  
  Migration: none for callers (no interface change); a hand-built composition that served the `apikey.token` group without the request context must declare `Api.RequestContext` (see the server changeset).
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.

### Patch Changes

- e101d10: `revokeClient` publishes `auth.apiKey.clientRevoked` only from the call that revoked the client: revoking an already-revoked client (or losing a concurrent revocation) is a silent no-op, as `revoke` already is for keys. `ApiKeyClientRecords.revoke` now answers a `boolean` (whether this call revoked the client); a custom `ApiKeyClientRecords` adapter returns `true` only when it set `revokedAt`.
- 89fb48c: API keys and `client_credentials` clients stop authenticating when their owner is suspended, banned, deactivated by SCIM, or erased.
  
  - `@awthaq/api-key`: `ApiKey.resolve` and `ApiKey.issueServiceToken` apply the shared sign-in gate (`Users.assertCanSignIn`) to the key's owner after the secret matched, so a missing or suspended owner is refused like an unknown credential. An outage reading the owner is the typed `StoreUnavailable` (503). The plugin now contributes to `ErasureRegistry` (deletes the user's keys and clients) and to `DataExportRegistry` (names, prefixes and scopes, never a secret or hash); `ApiKeyRecords` and `ApiKeyClientRecords` gain `deleteByOwner`. `ApiKeyShape["resolve"]` and `["issueServiceToken"]` gain `StoreUnavailable` in their error channel and `POST /api-key/token` declares it.
  - `@awthaq/server`: `CredentialResolverContribution.resolve` may fail with `StoreUnavailable`.
  
  Migration: `ApiKey.layer` now requires `Users` and `Erasure.ErasureRegistry`/`DataExport.DataExportRegistry` (all provided by a standard `Auth.make` composition and `Hooks.HooksLive`). A host with a custom `ApiKeyRecords` or `ApiKeyClientRecords` implements `deleteByOwner`. Keys of users erased before this release are now refused; purge the orphans with `DELETE FROM apikey_key WHERE "ownerId" NOT IN (SELECT id FROM users)` (and the same for `apikey_client`). BEH-EA-046.
- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 85c9e47: `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  
  Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` -> `Credentials.*` (same names; `Authentication.CredentialCarrier` is `Credentials.ClaimCarrier`). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` -> `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.
- 3514b28: The OAuth 2.0 device authorization grant (RFC 8628) ships as `@awthaq/device-authorization`, and `awthaq login` uses it (DAG-002, DAG-004, DAG-005; BEH-EA-299 to BEH-EA-307).
  
  - `@awthaq/device-authorization`: `POST /device/code` and `POST /device/token` (the polling states `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, at-most-once redemption), `POST /device/verify` / `approve` / `deny` for the page a signed-in user approves on, public clients from configuration or an operator's `registerClient`, hashed user and device codes, per-address, per-session and per-client rate limits, a `BeforeDeviceApproval` veto, erasure and export contributions, and `purgeExpired`. The minted session is an ordinary bearer session carrying the approving session's `amr`. Tables `device_authorization_grant` and `device_authorization_client` (append-only migrations); Postgres-tested.
  - `@awthaq/cli`: `awthaq login` without a token runs the device flow (a code and URL on stderr, a browser opened unless `--no-browser`, polling with +5 seconds on every `slow_down`); `--client-id` names the client (default `awthaq-cli`, which the plugin registers by default). A server without the plugin exits 9 naming it; a denied or expired request exits 8. `--token` and `AWTHAQ_TOKEN` are unchanged.
  - `@awthaq/core`: two audit events, `auth.deviceAuthorization.approved` and `.denied`.
  - `@awthaq/two-factor`: the session gate no longer diverts an `amr` that already records `mfa` (only this plugin's own completed challenge writes it), so a device approved from a session that proved a second factor is not asked again.
  - `@awthaq/api`: `Api.BackChannel`, an annotation for credential-in-the-request endpoints called by non-browser clients (`apikey.token`, the device `code`/`token` pair): they deliberately carry no `CsrfProtection`, and `awthaq doctor` no longer flags them as unprotected mutating endpoints (`@awthaq/api-key` annotates its token group).
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
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
- Updated dependencies [1cef4be]
- Updated dependencies [60ffc76]
- Updated dependencies [1cef4be]
- Updated dependencies [4353896]
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
- Updated dependencies [f8df2e4]
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
- Updated dependencies [9cdebdd]
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/jwt@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
