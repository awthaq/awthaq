# @awthaq/two-factor

## 0.2.0

### Minor Changes

- fe9dc94: Sign-in completion is one core module, `SignIn` (BEH-EA-322, ADR-EA-038). Every first factor (password, passkey, OAuth, SAML, device authorization, magic link, email OTP) and the second factor now finish through it: `clear` returns a branded `Clearance` (user lookup, suspension gate, `BeforeSignIn`, `BeforeSessionIssue`), `issue` is the only way to mint a session from it, `complete` is both, and `resume` is the divert owner's entry.
  
  - A suspended account's refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy, not only password.
  - A SAML sign-in completed by a second factor now keeps `fed` in its `amr`, is recorded for Single Logout, is role-mapped, and keeps its connection's tenant: the SAML Single Logout record and role mapping are a sign-in continuation (`SignIn.continuation`) that crosses the divert.
  - A user erased between credential proof and session issue is refused with the flow's own uniform error (OAuth: `OAuthCallbackFailed`; SAML: `SamlAssertionRejected`; password and passkey: `InvalidCredentials`) instead of a 500.
  - `Hooks.BeforeSessionIssue`'s input now always carries `amr` (required) and may carry a `handoff` (`{ tenantId?, continuation? }`); the second-factor challenge stores it.
  - `@awthaq/test` gains `SignInProbe`, recording taps for the sign-in and sign-up hook points.
  
  Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the sign-in itself must return the `handoff` it received to `SignIn.resume`. A detector counting `signInFailed` gains suspended refusals from every strategy. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or `clear`/`issue`), never `Sessions.issue`.
- 1cef4be: Two-factor handlers read the domain caller from `CurrentUser.current` instead of re-branding the wire principal.
  
  Migration: TwoFactorShape session parameters take Sessions.SessionId; pass the issued session's id or Sessions.SessionId(raw).
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- ae1175d: `@awthaq/two-factor` owns its events (ADR-EA-049): the seven `auth.twoFactor.*` definitions moved from `@awthaq/core` to `TwoFactorEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. The package's `SecondFactor` module emits them. The `TwoFactorMethod` and `TwoFactorPurpose` schemas they use move with them.
  
  Migration: `AuthEvents.TwoFactorEnabledEvent`, `AuthEvents.TwoFactorDisabledEvent`, `AuthEvents.TwoFactorVerifiedEvent`, `AuthEvents.TwoFactorChallengeFailedEvent`, `AuthEvents.TwoFactorRecoveryCodeUsedEvent`, `AuthEvents.TwoFactorRecoveryCodesRegeneratedEvent` and `AuthEvents.TwoFactorLockedEvent` (and `AuthEvents.TwoFactorMethod`, `AuthEvents.TwoFactorPurpose`) → `TwoFactorEvents.<same name>` from `@awthaq/two-factor`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.twoFactor.*`: subscribe with `AuthEvents.on(TwoFactorEvents.TwoFactorEnabledEvent, …)`, narrow the stream with `AuthEvents.is(TwoFactorEvents.TwoFactorEnabledEvent)`, decode an audit row with `AuditLog.payloadAs(TwoFactorEvents.TwoFactorEnabledEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(TwoFactorEvents.TwoFactorEnabledEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 9e6302f: `AuthPlugin.Service` takes an optional `sealedColumns` (the `SealedColumn.column` declarations of the plugin's own tables), `Auth.make` refuses a column on a table the plugin does not own or declared twice (`Auth/SealedColumnDeclarationInvalid`), and `auth.sealedColumns` lists every one, so a rotation sweep cannot forget the TOTP secret or a signing key: `SealedColumn.sweepDeployed({ also: auth.sealedColumns })`. The webhooks, organization, saml, jwt and two-factor plugins declare their seven columns (ADR-EA-019 rev 1.3, BEH-EA-339).
  
  Migration: none (the field is optional). A plugin that seals a column should declare it.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- 12ba9b4: Two-factor declares its rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06). The second-factor failure budget (BCR-006) keeps its own semantics (`SecondFactorLocked`, `auth.twoFactor.locked`, no `auth.rateLimit.exceeded`); only its bucket key comes from the shared rule, `SecondFactor.failureRule`.
  
  - `manageByUser` breach events report the real endpoint (`enable`, `confirm`, `disable`, `regenerateRecoveryCodes`) instead of the catch-all `manage`.
  - `failureBudget` reports `dimension: "principal"` (was `"identity"`), and any rule can be tuned with `RateLimits.overrides(RateLimits.tune(TwoFactor, { verifyByIp: { limit: 10 } }))`.
  
  Migration: `SecondFactor.failureKey` is removed; use `RateLimits.bucketKey(SecondFactor.failureRule, { userId })`. Rate-limit buckets are renamed (`two_factor:fail:<userId>` becomes `ratelimit:two_factor.failures:user:<userId>`), so a deploy resets the live counters once and lifts any second-factor lockouts in progress (they last at most the 15-minute failure window).
- c0ee090: `TwoFactor.records` is the plugin's record stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.
  
  - `TwoFactorSecrets` and `TwoFactorRecoveryCodes` are keyed `awthaq/two-factor/records/<Name>`; the bundle provides both over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. The `MemoryEnvelopes` test seam of `layerSecretsMemory` is not part of the bundle.
  - `SecondFactor.layer` is NOT absorbed into `TwoFactor.layer`: the two gates a host provides (`sessionGate`, `credentialResetGate`) sit beneath the plugin and require `SecondFactor` themselves, so they would have nothing to read it from. A host keeps providing it, beneath the gates.
  
  Migration: code that built a `Context` by the old key string must use the class. A host replaces `Layer.mergeAll(TwoFactorStore.layerSecretsMemory, TwoFactorStore.layerRecoveryCodesMemory)` (or the SQL pair) with `TwoFactor.records.memory` / `TwoFactor.records.sql`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 352b3ab: `TwoFactor` reads no request facts (ADR-EA-047). `verify` and `verifyRecovery` take no `ip` and no `{ userAgent }` argument and require `Api.AuthRequestContext`: the per-source rule keys on the request's address and the completed sign-in's session records its address and user agent. The plugin layer no longer requires `ClientAddress`.
  
  Migration: drop `ip` and the second argument from calls to `TwoFactor.verify` and `verifyRecovery`, and provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.
- c135199: `SecondFactor.consumeChallenge` is replaced by `SecondFactor.redeemChallenge(challengeId, use)`: the challenge, the code check and the session commit in one `Verification.redeem` transaction (BEH-EA-262, ADR-EA-020 rev 1.2, ADR-EA-039). A wrong code, a lockout or a suspension still spends the challenge (a wrong code re-issues `attempt + 1`); an outage while issuing the session gives the challenge back, so the person retries the code instead of restarting from the first factor.
  
  Migration: `consumeChallenge(id)` becomes `redeemChallenge(id, Effect.succeed)`. A custom `SecondFactorShape` implementation replaces `consumeChallenge` with `redeemChallenge`.
- 3fcb4f2: The TOTP secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - `SecretRecord.secret` is `SealedColumn.Sealed<string>` (was `envelope: string`); `TwoFactorSecrets.upsertPending` takes the base32 secret as a `Redacted` and seals it under `two_factor_secret:<userId>:secret`. The earlier `two_factor_secret:<userId>` AAD still opens, and a secret written under a retired encryption key re-seals, both by compare-and-swap on read; `TwoFactorSecrets.reencrypt` and the manual re-encryption in `SecondFactor` are removed. A secret that does not open is still the fail-closed `TwoFactorSecretUnreadable`-class defect, now `sealedColumn.readable` (`SealedColumn.orDie`).
  - `layerSecretsMemory/layerSecretsSql` require `Encryption` (`SecondFactor` no longer does); `MemoryEnvelopes` is the memory adapter's test seam. Every `TwoFactorSecrets`, `TwoFactorRecoveryCodes`, `SecondFactor` and `TwoFactor` method fails with `StoreUnavailable` instead of dying; the credential-reset gate, whose hook point can only abort, still turns an outage into a defect that rolls the reset back.
  
  Migration: pass a `Redacted` secret to `upsertPending`; open `record.secret` with `SealedColumn.orDie(record.secret.open)`; provide `Encryption` to the secrets layers; handle `StoreUnavailable` on the widened methods; run `SealedColumn.sweep` on `two_factor_secret.secret` to finish re-sealing secrets that are never read. BEH-EA-263.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 3514b28: The OAuth 2.0 device authorization grant (RFC 8628) ships as `@awthaq/device-authorization`, and `awthaq login` uses it (DAG-002, DAG-004, DAG-005; BEH-EA-299 to BEH-EA-307).
  
  - `@awthaq/device-authorization`: `POST /device/code` and `POST /device/token` (the polling states `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, at-most-once redemption), `POST /device/verify` / `approve` / `deny` for the page a signed-in user approves on, public clients from configuration or an operator's `registerClient`, hashed user and device codes, per-address, per-session and per-client rate limits, a `BeforeDeviceApproval` veto, erasure and export contributions, and `purgeExpired`. The minted session is an ordinary bearer session carrying the approving session's `amr`. Tables `device_authorization_grant` and `device_authorization_client` (append-only migrations); Postgres-tested.
  - `@awthaq/cli`: `awthaq login` without a token runs the device flow (a code and URL on stderr, a browser opened unless `--no-browser`, polling with +5 seconds on every `slow_down`); `--client-id` names the client (default `awthaq-cli`, which the plugin registers by default). A server without the plugin exits 9 naming it; a denied or expired request exits 8. `--token` and `AWTHAQ_TOKEN` are unchanged.
  - `@awthaq/core`: two audit events, `auth.deviceAuthorization.approved` and `.denied`.
  - `@awthaq/two-factor`: the session gate no longer diverts an `amr` that already records `mfa` (only this plugin's own completed challenge writes it), so a device approved from a session that proved a second factor is not asked again.
  - `@awthaq/api`: `Api.BackChannel`, an annotation for credential-in-the-request endpoints called by non-browser clients (`apikey.token`, the device `code`/`token` pair): they deliberately carry no `CsrfProtection`, and `awthaq doctor` no longer flags them as unprotected mutating endpoints (`@awthaq/api-key` annotates its token group).
- 1cef4be: Each table's migrations moved into its records module and are written once for both dialects. Migration names and order are unchanged; an already-migrated database applies nothing new and `awthaq migration status` reports no drift. Plugin indexes are created `IF NOT EXISTS` (SSMS-006), so an index built `CONCURRENTLY` beforehand no longer fails the deploy.
  
  Migration: none.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- a232d8e: `SessionDelivery.respond(request, mint)` is the one call a session-minting handler makes: it validates `X-Awthaq-Token-Delivery`, runs `mint` only after that, then delivers the session as a cookie or a bearer body (plan 01 phase 6).
  
  - `@awthaq/server`: adds `SessionDelivery.respond`; `AuthHttp.coreHandlers` logs one warning at layer build when `RequestContext.layer` is not merged on the router (sessions would record no address or user agent), silenced by providing `RequestContext.warnWhenAbsent` as `false`; `RequestContext.layer` stays opt-in. `README.md` documents both.
  - `@awthaq/password`, `@awthaq/two-factor`, `@awthaq/magic-link`, `@awthaq/passkey`: every handler that mints a session goes through `respond`; behaviour on the wire is unchanged (a concealed sign-up still refuses a bad delivery header first).
  - `@awthaq/test`: `TestAuth` silences the new warning, since the in-process harness serves without `RequestContext.layer`.
- b0b6a4d: One fresh-session gate, `Sessions.requireFresh`, replaces the copies in passkey, two-factor and qadi; `POST /change-email` now uses it.
  
  - `@awthaq/core`: new `Sessions.requireFresh(userId, id, maxAge)` and the `SessionStale` error (`Sessions/Stale`, with `maxAgeSeconds` and a `reason` of `notLive` or `stale`). Both layers share one implementation built on `findOwned` (BEH-EA-320).
  - `@awthaq/passkey`, `@awthaq/two-factor`, `@awthaq/qadi`: enrolment, enable/disable/regenerate and the `reauth` obligation call `requireFresh` and map `SessionStale` to their existing wire errors (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`); the wire contracts do not change.
  - `@awthaq/password`: `POST /change-email` needs a session that proved a credential within the new `PasswordConfig.reauthMaxAge` (default 5 minutes), else `403 PasswordReauthRequired { maxAgeSeconds }`. `PasswordShape["requestEmailChange"]` takes `currentSessionId`.
  
  Migration: a hand-written `Sessions` test double adds a `requireFresh` member. A client of `POST /change-email` handles `PasswordReauthRequired` by running `POST /password/reauthenticate` (or a passkey step-up) and retrying, or the host sets `reauthMaxAge: Duration.infinity` to keep the old behaviour. Callers of `Password.requestEmailChange` pass `currentSessionId`.
- 66c85af: The second-factor challenge is a user-keyed `VerificationLink` purpose and `SecondFactor.redeemChallenge` redeems it through the shared redeemer; no change for callers (BEH-EA-262, ADR-EA-039 decision 9).
  
  Migration: none.
- 34787ed: The two-factor record stores have RecordsContract suites (plan 25 ticket 21, ADR-EA-041 decision 9, BEH-EA-264/265):
  
  - Concurrent recovery-code regenerations leave exactly one set. Before, on Postgres, two regenerations racing each other could each delete the old set and insert their own, leaving both new sets valid. The SQL `TwoFactorRecoveryCodes.replaceAll` now runs under the user's `SqlStore.atomically` lock (`two_factor_recovery_code:user:<id>`), and `deleteAllByUser` takes the same lock.
  - `TwoFactorSecrets` (`upsertPending`, `confirm`, `advanceLastUsedStep`) and `TwoFactorRecoveryCodes` (`replaceAll`, `markUsed`) are proven atomic by 8-way race cases on memory and SQL, Postgres included under `pnpm test:pg`.
  
  Migration: a custom adapter through `@awthaq/two-factor`'s `TwoFactorRecoveryCodes` must serialise `replaceAll` per user, so that concurrent calls leave exactly one whole set (memory: one `Ref.update`; SQL: the delete and the inserts in one transaction under a per-user lock).
- e6c3620: A unit of work releases state-change events on commit and attempt events either way (ADR-EA-037, BEH-EA-321).
  
  - `@awthaq/ports`: `SqlTransaction.UnitOfWork`, `SqlTransaction.onCommit`, `SqlTransaction.afterUnit` and `SqlTransaction.transactional(sql)`. `SqlTransaction.layerSql` is built on `transactional`, so every transaction opened through the port buffers two lanes: `onCommit` work runs after the outermost unit commits (never on rollback), `afterUnit` work runs after it ends either way. With no transaction (or on `layerNoop`) both run immediately.
  - `@awthaq/core`: `AuthEvents.publish` writes a state-change event's audit row inside the transaction and releases its bus copy on commit; an attempt event (`defineEvent(..., { attempt: true })`: `auth.user.signInFailed`, `auth.token.replay`, `auth.twoFactor.challengeFailed`, `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, `auth.admin.actionDenied`, `auth.admin.impersonationDenied`, `auth.authz.denied`, `auth.organization.permissionDenied`, `auth.deviceAuthorization.denied`) records its audit row and bus copy after the unit ends, committed or not. `AuthEvents.isAttemptEvent(tag)` is new. `HookPoint.observe` taps run after the enclosing unit commits and not at all if it rolls back. `Verification.consume`'s `deferMiss` option and `Verification.recordMiss` are removed: a miss is recorded through the `afterUnit` lane. Core's own raw `sql.withTransaction` calls (`Sessions.issue`, `Accounts.unlink`) now go through `transactional`.
  - `@awthaq/sql`: the per-request Postgres tenant transaction (`TenantScope.withTenant`) is a unit of work, so a failed tenanted request delivers no state-change event. `AuditLogRepository.insert` runs in a savepoint inside a transaction, so a failed audit write under the `"bestEffort"` policy no longer aborts the surrounding Postgres transaction.
  - `@awthaq/admin`, `@awthaq/cli`, `@awthaq/organization`, `@awthaq/qadi`, `@awthaq/two-factor`: raw `sql.withTransaction` replaced by `SqlTransaction.transactional(sql)`.
  - `@awthaq/password`: `confirmReset`, `verifyEmail` and `confirmEmailChange` drop the `TokenMissed`/`settleMiss` dance; a wrong second-factor code during `confirmReset` is now audited although the reset rolls back (BEH-EA-266).
  - `pnpm check:transactions` (part of `pnpm check`) fails on a bare `sql.withTransaction(` in `packages/*/src`.
  
  Migration: an `AuthEvents.on` handler or observe tap for an operation that runs in a transaction now runs after the commit, and not at all when the operation rolls back; failure and attempt events are now recorded even when the operation rolls back. `Verification.consume(identifier, value, { deferMiss })` becomes `consume(identifier, value)` and `Verification.recordMiss` is gone (a custom `Verification` implementation drops it). Host code that opens its own `sql.withTransaction` around awthaq calls should use `SqlTransaction.transactional(sql)` from `@awthaq/ports`. A custom `SqlTransaction` implementation is unchanged (`withTransaction` is still the whole interface); to give its transactions a unit of work, build it on `transactional`.
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
- Updated dependencies [9cdebdd]
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
