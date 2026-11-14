# @awthaq/saml

## 0.2.0

### Minor Changes

- fe9dc94: Sign-in completion is one core module, `SignIn` (BEH-EA-322, ADR-EA-038). Every first factor (password, passkey, OAuth, SAML, device authorization, magic link, email OTP) and the second factor now finish through it: `clear` returns a branded `Clearance` (user lookup, suspension gate, `BeforeSignIn`, `BeforeSessionIssue`), `issue` is the only way to mint a session from it, `complete` is both, and `resume` is the divert owner's entry.
  
  - A suspended account's refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy, not only password.
  - A SAML sign-in completed by a second factor now keeps `fed` in its `amr`, is recorded for Single Logout, is role-mapped, and keeps its connection's tenant: the SAML Single Logout record and role mapping are a sign-in continuation (`SignIn.continuation`) that crosses the divert.
  - A user erased between credential proof and session issue is refused with the flow's own uniform error (OAuth: `OAuthCallbackFailed`; SAML: `SamlAssertionRejected`; password and passkey: `InvalidCredentials`) instead of a 500.
  - `Hooks.BeforeSessionIssue`'s input now always carries `amr` (required) and may carry a `handoff` (`{ tenantId?, continuation? }`); the second-factor challenge stores it.
  - `@awthaq/test` gains `SignInProbe`, recording taps for the sign-in and sign-up hook points.
  
  Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the sign-in itself must return the `handoff` it received to `SignIn.resume`. A detector counting `signInFailed` gains suspended refusals from every strategy. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or `clear`/`issue`), never `Sessions.issue`.
- 1cef4be: `Saml.logout` takes the domain caller.
  
  Migration: `Saml.logout` takes `CurrentUser.Caller` (`CurrentUser.of(principal)` from a principal).
- 1cef4be: SAML admin operations take the domain caller instead of the wire principal.
  
  Migration: `SamlAdmin` operations take `CurrentUser.Caller` (`CurrentUser.of(principal)` from a principal).
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- f831b6c: Finishes `@awthaq/webhooks` and `@awthaq/saml` (BEH-EA-308 through 318, ADR-EA-036).
  
  **Webhooks.** The event envelope and `AuditLogRecord` carry `tenantId` (the value the audit row already stored); endpoints belong to a tenant, hear only that tenant's events and are administered inside that tenant's scope (`platformEndpointsHearAllTenants` opts the platform's own endpoint into every tenant's); `POST .../endpoints/:id/test` sends a signed synthetic `webhook.test` event through the real delivery path (one attempt, never counted against the endpoint); every successful administrative mutation publishes an `auth.webhooks.*` audit event of identifiers; per-endpoint custom headers (values sealed, never returned); and the connection is pinned to the address that was checked (`HostResolver.pin`, `PinnedHttp` in `@awthaq/ports`, `WebhookTransport.layerNodePinned`), closing DNS rebinding.
  
  **SAML.** Signed AuthnRequests with an SP key stored sealed (`SamlSpKeys`); Single Logout in both directions over Redirect and POST, revoking with the new session reason `federatedLogout`; the `saml.admin` group (fail-closed, tenant-scoped connection CRUD, IdP metadata import from XML or a URL through the pinned fetcher, refresh, SP key rotation) and `saml.account` (`POST /auth/saml/logout`); role mapping under a `canGrant` ceiling (`Organization.checkRoleCeiling`/`syncMemberRoles`); and the `Sso` dispatcher. IdP-initiated login and encrypted assertions stay refused (ADR-EA-036).
  
  Migration: `Webhooks.Webhooks.background()` requires a `WebhookTransport` instead of an `HttpClient` (provide `WebhookTransport.layerNodePinned`, or `WebhookTransport.layerHttpClient` over your client, which cannot pin); `EventMetadata`/`Published` gain a required `tenantId: Option<string>` (hand-built envelopes add `tenantId: Option.none()`); `AuditLogRecord` gains `tenantId`; `EndpointRecord` gains `tenantId`, `headers` and `headerNames`, and `EndpointDto` gains `tenantId` and `headerNames`; the plugin migrations `add_webhooks_endpoint_tenant`, `add_webhooks_endpoint_headers`, `add_saml_connection_signing_logout_roles`, `create_saml_sp_key` and `create_saml_session` are appended; `SamlConnections.layerStore` now requires `SamlSpKeys` (which requires `Encryption`) and the `Organization` service, and `Saml.Saml.layer` requires `SamlSpKeys`, `SamlMetadataFetcher` and the admin/user authentication; `SamlConfig.rateLimits` gains `slo` and `sso`; `SessionRevocationReason` gains `federatedLogout`; `OrganizationShape` gains `checkRoleCeiling` and `syncMemberRoles`; `HostResolver.refusal` is now `HostResolver.pin` underneath.
- 95c6c09: An email domain belongs to one organization across protocols.
  
  - `@awthaq/organization`: new `DomainClaims` record store (`organization_domain_owner`, whose primary key makes a first claim atomic, and `organization_domain_claim`), part of `Organization.records`. `OrganizationConnectionStore` claims a connection's `emailDomains` through it in the connection's own transaction and fails `ConnectionDomainTaken` for a domain another organization owns over any protocol; `connectionsOnOrganizationDelete` releases the organization's claims. `OrganizationConnections.layerStore` now requires `DomainClaims` and `SqlTransaction`.
  - `@awthaq/saml`: `SamlConnectionStore` claims through the same store and fails `SamlDomainTaken`; creating, updating domains of, and deleting a connection (and deleting its organization) keep the claim in step. `Saml.layer` requires `DomainClaims`, provided by `Organization.records`.
  - BEH-EA-317, ADR-EA-023 Decision 4. The organization that owns a domain may still route it over both protocols (`Sso.preferred` picks).
  
  Migration: two migrations are added: organization's `create_organization_domain_claim` (creates the two tables and claims the stored OIDC domains) and Saml's `claim_saml_connection_domains`, which claims the stored SAML domains and FAILS, naming the domains, when one organization holds a domain over OIDC that another holds over SAML. Before upgrading, list such clashes (`SELECT d.domain FROM saml_connection_domain d JOIN saml_connection c ON c.id = d."connectionId" JOIN organization_oauth_connection_domain o ON o.domain = d.domain WHERE o."organizationId" <> c."organizationId"`) and delete the connection (or its domains) of the organization that does not own the domain. `Auth.make` numbers every plugin's migrations in one list, so the new organization migration shifts the ids of the plugins composed after it: on a database that is already migrated, `awthaq migration status` refuses it (ECS-009); re-baseline the plugin ledger or migrate a fresh database. A host composing `OrganizationConnections.layerStore` or a hand-built `Saml.layer` by hand provides `DomainClaims.layerMemory`/`layerSql` and `SqlTransaction`.
- a305c26: Deleting an organization removes the connections that hang off it, in its own transaction (ADR-EA-040, BEH-EA-235). `OrganizationDeletion` is an aggregating registry (like `Erasure.contribute`), exposed by `Organization.layer`; `OrganizationDirectory.delete` runs every contribution's `inTransaction` after its own cascade and every `afterCommit` once the transaction has committed, so a failing contribution rolls the deletion back instead of leaving rows behind. OIDC/OAuth2 connections (`connectionsOnOrganizationDelete`), SAML connections (their domains, SP keys and Single Logout sessions) and SCIM connections (and their mappings, through the new `ScimRecords.removeAllForOrganization`) previously outlived the organization. The OIDC `OrganizationConnectionStore` now refuses an unknown or suspended organization (`InvalidConnection`) and takes an `Actor` on `create`, `update` and `remove`, publishing the new core events `auth.organization.connectionCreated` / `connectionUpdated` / `connectionDeleted` (identifiers only, with the acting user's id when the actor names one; `@awthaq/core`).
  
  Migration: `OrganizationConnections.cleanupOnOrganizationDelete` (an opt-in observe tap whose failures were swallowed) is replaced by `connectionsOnOrganizationDelete`; provide it where the store is. `OrganizationConnectionStore.create(input)` becomes `create(actor, input)`, `update(organizationId, connectionId, patch)` becomes `update(actor, organizationId, connectionId, patch)` and `remove(organizationId, connectionId)` becomes `remove(actor, organizationId, connectionId)` (use `OrganizationActor.application("...")` for application code). `OrganizationConnections.layerStore` now requires the exposed `OrganizationDirectory` and `AuthEvents`. `Saml.layer` and `Scim.layer` now require the `OrganizationDeletion` registry that `Organization.layer` exposes. A custom `ScimRecords` implements `removeAllForOrganization(organizationId)`. A new tenancy table is not needed: no migration.
- d3a548f: `@awthaq/saml` owns its events (ADR-EA-049): the five definitions `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated, logoutRejected}` moved from `@awthaq/core` to `SamlEvents`, are declared on the `Saml` plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `auth.admin.actionDenied`, which saml also publishes, stays in core.
  
  Migration: `AuthEvents.SamlConnectionCreatedEvent`, `AuthEvents.SamlConnectionUpdatedEvent`, `AuthEvents.SamlConnectionDeletedEvent`, `AuthEvents.SamlSigningKeyRotatedEvent` and `AuthEvents.SamlLogoutRejectedEvent` → `SamlEvents.<same name>` from `@awthaq/saml`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.saml.*`: subscribe with `AuthEvents.on(SamlEvents.SamlConnectionCreatedEvent, …)`, narrow the stream with `AuthEvents.is(SamlEvents.SamlConnectionCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(SamlEvents.SamlConnectionCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(SamlEvents.SamlConnectionCreatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 9e6302f: `AuthPlugin.Service` takes an optional `sealedColumns` (the `SealedColumn.column` declarations of the plugin's own tables), `Auth.make` refuses a column on a table the plugin does not own or declared twice (`Auth/SealedColumnDeclarationInvalid`), and `auth.sealedColumns` lists every one, so a rotation sweep cannot forget the TOTP secret or a signing key: `SealedColumn.sweepDeployed({ also: auth.sealedColumns })`. The webhooks, organization, saml, jwt and two-factor plugins declare their seven columns (ADR-EA-019 rev 1.3, BEH-EA-339).
  
  Migration: none (the field is optional). A plugin that seals a column should declare it.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- 296cf3a: SAML and SSO declare their rate-limit rules and spend them through `RateLimits.budget` (plan 06). `saml.login`, `saml.acs`, `saml.slo`, `saml.admin` (per administrator, the admin action is the event's endpoint) and `sso.start` were enforced but never declared or registered; they now appear in `awthaq plugin list --rules`, in `Auth.make(...).manifest.rateLimits` and in `RateLimitsRegistry.registered`, and can be tuned with `RateLimits.overrides(RateLimits.tune(Saml, { login: { limit: 10 } }))`.
  
  - `SamlConfig.config({ rateLimits })` now accepts a partial object: the endpoints it does not name keep their defaults (it used to replace the whole object).
  - New exports `SamlConfig.defaultRateLimits` and `SamlConfig.defaultAdminRate`, the one source the config defaults and the rule tables share.
  - `SamlConfig.rateLimits.sso` is the budget of the `Sso` plugin's `start` rule.
  
  Migration: rate-limit buckets are renamed (`saml:login:<ip>` becomes `ratelimit:saml.login:ip:<ip>`, `saml:acs:<ip>` becomes `ratelimit:saml.acs:ip:<ip>`, `saml:slo:<ip>` becomes `ratelimit:saml.slo:ip:<ip>`, `saml:admin:<userId>` becomes `ratelimit:saml.admin.admin:user:<userId>`, `sso:start:<ip>` becomes `ratelimit:sso.start:ip:<ip>`), so a deploy resets the live counters once; entries in a shared store expire within one minute. `SamlAdmin.makeAdmin` and `SamlSlo.makeSlo`'s `limiter` dependency are internal and changed shape.
- aebb30d: `Saml.records` is the plugin's record store as one matched `{ memory, sql }` bundle, and `Saml.layer` now provides the connection store and the SP key store itself.
  
  - `SamlRecords` is keyed `awthaq/saml/records/SamlRecords`; the bundle provides it over memory and over SQL (the `MemoryEnvelopes` test seam is not part of it).
  - `Saml.layer` absorbs `SamlConnections.layerStore` and `SamlSpKeys.layer` (always required, storage-agnostic, built over `SamlRecords`); they stay in its output, so `Sso` still reads `SamlConnectionStore`. `SamlMetadataFetcher` stays the host's (a network adapter: `layerPinned` in production). `Sso` declares no records, and its `OrganizationConnectionStore` stays host-composed (`OrganizationConnections.layerStore`): OAuth connections are optional in `Organization`.
  
  Migration: remove your own `SamlConnections.layerStore` and `SamlSpKeys.layer` from the host graph (keeping them is harmless but redundant). Code that built a `Context` by the old record key string must use the class. A host replaces `SamlRecords.layerMemory` / `SamlRecords.layerSql` with `Saml.records.memory` / `Saml.records.sql`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 085235e: `Saml` and `Sso` read no request facts (ADR-EA-047). `Saml.authnRequest`, `acs` and `slo` (`SamlSlo.SloInput`) take no `ip` (and `acs` no `userAgent`) and require `Api.AuthRequestContext`; `Saml.logout` drops the `ip` it never read; `Sso.start(input)` drops its positional `ip` and requires the context. The per-source rules key on the request's address, the ACS session records its address and user agent, and a rejected assertion is announced through core's `SignIn.failed`. Neither layer requires `ClientAddress` any more.
  
  Migration: drop `ip`/`userAgent` from calls to `Saml.authnRequest`, `acs`, `slo` and `logout`, and the second argument of `Sso.start`; provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
- 7e9834e: Plugins contribute their own retention rules to `Retention.sweep`.
  
  - `@awthaq/core`: new `Retention.contribute({ id, order?, make })` and `Retention.RetentionRegistry` (provided by `Hooks.HooksLive`, like the erasure registry). `Retention.sweep` runs every contribution after the core purges, isolates a failing one, and reports `SweepReport.plugins: ReadonlyArray<{ id, deleted, failed }>`; its requirements gain `RetentionRegistry`. ADR-EA-031 Decision 6 amended (revision 1.4); BEH-EA-337.
  - `@awthaq/saml`: contributes `saml.sessions` and no longer prunes session records inside every sign-in.
  - `@awthaq/device-authorization`: contributes `device_authorization.grants`. `@awthaq/jwt`: contributes `jwt.revocations` (`RevocationStore` gains `purgeExpired`). `@awthaq/organization`: contributes `organization.invitations` (new `invitationRetention`, default 30 days; `InvitationRecords` gains `purgeExpired`). `@awthaq/passkey`: contributes `passkey.challenges`. `@awthaq/webhooks`: contributes `webhooks.deliveries` (the worker keeps its hourly prune).
  
  Migration: a composition that installs one of these plugins must provide `Retention.RetentionRegistry`; every `Auth.make` composition and `Hooks.HooksLive` already do. A host with its own `RevocationStore` or `InvitationRecords` implements `purgeExpired`. SAML session records now age out only when the host runs `Retention.sweep` or `Retention.layerScheduled`; a host that relied on the inline prune must schedule the sweep.
- 1cef4be: The SAML ACS lands through the same-site interstitial while the session cookie is `SameSite=Strict` (BEH-EA-350).
  
  The IdP's POST is cross-site, so a `302` kept the landing request in a cross-site redirect chain and the browser withheld the `Strict` session cookie: the first page after sign-in looked signed out. The ACS now answers a `200 text/html` page whose meta refresh starts a fresh same-site navigation, which carries the cookie, exactly as the OAuth callback does (PV-016). The ACS contract's success is now `302` or `text/html`.
  
  Migration: a host or test that asserted the ACS's `302` under the default cookie now sees a `200` interstitial with the same `Set-Cookie`; `SessionCookie.config({ mode: SessionCookie.HostLax })` keeps the `302`. A deployment that worked around the signed-out first landing (a client-rendered landing route, a re-navigating page) can drop the workaround. BEH-EA-350, BEH-EA-055.
- 1cef4be: SAML's by-id administrative operations (get, update, delete, refresh metadata, rotate and list signing keys) read the connection first and ask `canManageSaml` with its `organizationId` (BEH-EA-347). This closes a cross-organization read and write: a predicate that delegated one organization (`organizationId === undefined || organizationId === A`) used to admit every by-id call on an untenanted admin surface. A refused connection now answers like an absent one (404) for an administrator who holds the action in general, and 403 otherwise; each refusal publishes `auth.admin.actionDenied` naming the organization.
  
  Migration: `canManageSaml` now receives the connection's `organizationId` for the six by-id operations. A predicate that approved by-id calls through `organizationId === undefined` should be reviewed: `undefined` now means "the action in general".
- faae8be: A connection with `trustsEmail` now links only addresses in the domains it claims (`emailDomains`, BEH-EA-317), and the user it creates on a first sign-in has its address verified, as a trusted OAuth provider's does (BEH-EA-245, ADR-EA-043). The resolution moves to core's `FederatedIdentity`; two concurrent first sign-ins for one NameID sign in as one user, and a second lost race in a row is the uniform `SamlAssertionRejected`.
  
  Migration: a `trustsEmail` connection whose users sign in with addresses outside its `emailDomains` stops auto-linking them (they get `SamlAssertionRejected`, reason `emailInUse`): add the domains to the connection, or link those accounts explicitly. Find them with `SELECT c.id, a.subject FROM saml_connection c JOIN accounts a ON a."providerId" = 'saml:' || c."organizationId" || ':' || c.id WHERE c."trustsEmail"` and compare each linked user's address domain with the connection's domains. ADR-EA-043, BEH-EA-245.
- 71a4af0: The SAML records are scoped by their organization, the SP private key is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - `SamlRecords`: `findById` and `findByDomain` (a protocol message or home-realm discovery names a connection before any tenant is known) and `pruneSessions` (the retention sweep) take a `TenantScoped.CrossTenant` as their first argument, and run under `TenantScoped.lift`; `update` and `remove` take the connection's `organizationId` and no longer touch another organization's row. `saml_connection` is Keyed, and its domain, key and session tables are Derived.
  - `SpKeyRecord.privateKey` is `SealedColumn.Sealed<string>`; `NewSpKey.privateKey` is a `Redacted` PEM that the records seal under `saml_sp_key:<id>:privateKey` (the old `saml-sp-key:` AAD still opens and re-seals on read, and so does a key sealed under a retired encryption key). `SamlRecords.layerMemory/layerSql` require `Encryption`; `SamlSpKeys` no longer does and its exported `aad` is removed. A signing key that does not open is the `sealedColumn.readable` defect (was `saml.signingKeyOpens`).
  - Every `SamlRecords`, `SamlSpKeys`, `SamlConnectionStore`, `Saml` and `Sso` method fails with `StoreUnavailable` instead of dying; the metadata, SSO start and admin endpoints declare it. `@awthaq/sql`'s `StoreFailure.orStoreUnavailable` now accepts an effect whose `E` also carries domain errors and leaves them alone.
  
  Migration: pass a witness (`TenantScoped.crossTenant("<why>")`) to `findById`, `findByDomain` and `pruneSessions`, and `organizationId` to `update` and `remove`; open an SP key with `SealedColumn.orDie(record.privateKey.open)`; provide `Encryption` to `SamlRecords`; run `SealedColumn.sweep` on `saml_sp_key.privateKey` to finish re-sealing rows that are never read. BEH-EA-314.
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 1cef4be: SCIM tokens, organization invitation tokens and verification values are now hashed through `SecretHash.digest`, and every hex encoding goes through `Hmac.toHex`. The stored hashes are byte-identical (pinned by known-answer tests), so existing tokens, invitations and imported scrypt passwords keep working.
  
  Migration: none.
- ff622f0: `OAuth.callback` refuses a `state` that names another purpose's verification token before consuming it, so a crafted state can no longer spend another flow's attempts (BEH-EA-057, BEH-EA-122). OAuth and SAML state use the shared `VerificationLink` codec.
  
  Migration: none.
- a5927c3: The organization row is a system module, `OrganizationDirectory` (`find`, `findActive`, `requireActive`, `isSlugAvailable`, `listForUser`, `listPage`, `create`, `update`, `delete`, `suspend`, `reinstate`), exposed by `Organization.layer` (ADR-EA-040). `create` writes the organization and its creator's membership in one transaction (a failed creation leaves neither) and the creator's membership now fires `AfterAddMember`. `suspend` and `reinstate` take a `PlatformAdminActor`, run the new `BeforeSuspendOrganization` / `AfterSuspendOrganization` and `BeforeReinstateOrganization` / `AfterReinstateOrganization` hook points, and still publish `auth.admin.organizationSuspended` / `organizationUnsuspended`. `AdminTenants` suspends, reinstates and lists through the Directory instead of writing `OrganizationRecords`, so a platform suspension is observable and `@awthaq/qadi`'s `DecisionCacheInvalidationLive` now clears a long-lived decision cache on suspension, reinstatement, a team move and a team-role change. The SAML and SCIM token and connection gates read `OrganizationDirectory.findActive` / `find`. `OrganizationQadi.relationships` reads the Directory.
  
  Migration: `AdminTenantsShape["suspendOrganization"]` and `["unsuspendOrganization"]` (and the `/admin/organizations/:id/suspend` and `/unsuspend` endpoints) can now answer `HookAborted` (`403`) when a `BeforeSuspendOrganization` / `BeforeReinstateOrganization` tap vetoes. `AdminTenants`, `SamlConnections.layerStore`, `Saml.layer` and `ScimAuthenticationLive` require the exposed `OrganizationDirectory` instead of `OrganizationRecords`. A host that installs `DecisionCacheInvalidationLive` must provide `OrganizationHooksLive` (as before) which now includes the four new points. `OrganizationLive` compositions are unchanged. The tenant middleware still reads `OrganizationRecords` directly (a raw read of a suspended organization is deliberate).
- 41f57a0: Membership is a system module, `OrganizationMembers` (`add`, `setRoles`, `remove`, `find`, `list`, `listForUser`), exposed by `Organization.layer` (ADR-EA-040, BEH-EA-330). It owns the owner invariant, `membershipLimit`, role names, the grant `Bound`, MTI-003 uniqueness, the veto, the removal cascade (membership, active context, team memberships in one transaction) and the events and observe points, for every caller. The SAML role mapping is `setRoles` with an `IdentityProvider` actor and `ceilingOf` as its `Bound`; SCIM provisioning is `add` with a `Directory` actor and `Unbounded`; the authorized `removeMember`, `updateMemberRole`, `leave` and `listMembers` delegate. `Organization.addMember`, `syncMemberRoles`, `checkRoleCeiling` and `attributesFor` leave `OrganizationShape` (the interface has 41 methods): they are `OrganizationMembers.add`, `OrganizationMembers.setRoles({ ifAbsent: "add" })`, and `OrganizationAuthority.checkRoleCeiling` / `attributesFor`.
  
  Migration: `organization.addMember({ organizationId, userId, role })` becomes `OrganizationMembers.add(OrganizationActor.application("..."), { organizationId, userId, role, bound: OrganizationActor.Bound.Unbounded() })`; `syncMemberRoles({ roles, ceiling })` becomes `OrganizationMembers.setRoles(actor, { roles, bound: yield* OrganizationAuthority.ceilingOf(organizationId, ceiling), ifAbsent: "add" })`. Behaviour: a caller without `member:delete` / `member:update` is now answered `403` before the owner invariant (it was `409` for the last owner, which leaked that fact); setting a member's roles to exactly what they hold is a no-op for HTTP too (no write, veto, event or observer); a veto tap that rewrites the roles is bounded on what is stored. `@awthaq/saml` and `@awthaq/scim` require the exposed `OrganizationMembers` / `OrganizationAuthority` instead of `Organization`'s removed methods.
- 05c2ef7: The organization records are scoped by their organization key, a cross-organization method takes a witness, the client secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - Every method that reads or writes across organizations takes a `TenantScoped.CrossTenant` as its first argument (`OrganizationRecords.listByIds/listPage/setSuspended`, `MembershipRecords.listByUser/deleteAllByUser`, `InvitationRecords.findById/findByTokenHash/listByEmail/listByInviter/countPendingByInviter/removeAllForUser`, `TeamRecords.findTeamByIdAnyOrg/removeUserFromAllTeams`, `ConnectionRecords.findByEmailDomain`, `ActiveContextRecords.deleteAllByUser`); its statement runs under `TenantScoped.lift`, so it still sees every organization inside a request's Postgres RLS transaction. `InvitationRecords.setTokenHash/updateStatus` and the connection-domain deletes now also filter by `organizationId`.
  - `ConnectionRecord.clientSecret` is `Option<SealedColumn.Sealed<string>>` (and `secretRevision` is the compare-only ciphertext fingerprint); `ConnectionInput`/`ConnectionPatch` take a `Redacted` secret. Secrets sealed under the old `organization-oauth-connection:` AAD still open and re-seal on read. `ConnectionRecords.layerMemory/layerSql` require `Encryption`; `OrganizationConnections` and its store no longer do.
  - The records modules, `OrganizationShape`, `OrganizationConnectionStore`, `AdminTenants` and the SAML/SCIM services fail with `StoreUnavailable` instead of dying; the tenant middleware answers it `503`; the SCIM bearer middleware and the SAML metadata/SSO endpoints declare it. `@awthaq/sql` adds `StoreFailure.orConflict` and `TenantScoped.liftOn`, and `orStoreUnavailable` accepts a `RETURNING` that returned no row (a defect).
  
  Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to the methods above, and pass `organizationId` to `InvitationRecords.setTokenHash/updateStatus`; open a connection's secret with `SealedColumn.option(record.clientSecret.value.open)`; provide `Encryption` to `ConnectionRecords`; handle `StoreUnavailable` on the widened service methods. BEH-EA-284, BEH-EA-328.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- 22cbfcf: Fix: on libSQL, a domain another OIDC connection already holds answers `ConnectionDomainTaken`, not 503 (`StoreUnavailable`). A SAML domain insert that fails a constraint other than a unique one is no longer reported as `SamlDomainTaken`; it is a store failure. Both now classify through `StoreFailure.isUniqueViolation` (ADR-EA-028, ADR-EA-041).
  
  Migration: none.
- 1cef4be: Built against `@qadi/core`, `@qadi/http` and `@qadi/react` 0.12 (the peer ranges move from `^0.11.0` to `^0.12.0`). `@awthaq/qadi`'s `ObligationHandlers.reauth` is an `ObligationHandler` of 0.12, so it takes the `{ question, decision }` discharge and reads `decision.obligations`; `onObligations: ObligationHandlers.reauth` is unchanged. `@awthaq/react` re-exports the new `useQuestions` hook (the devtools dock feed, `useDevtoolsFeed` and `runtimeLayer`, stays on `@qadi/react`).
  
  Migration: a host with an endpoint that declares neither `RequiredPermission` nor `publicEndpoint` (or that `RequirePermission` does not cover) now fails at startup, when `guardApi` is built, with `AccessNotDeclared` or `RequirePermissionNotAttached`, instead of serving a 500 per request: annotate the endpoint. A direct call `ObligationHandlers.reauth([...obligations])` becomes `ObligationHandlers.reauth({ question, decision })`; guard a Path B `HttpApi` with `guardApi(Api)` (replaces `RequirePermissionLive` and `registerApi`, provide `PermissionRegistryLive` once where the stack is composed) and see the `@qadi/http` 0.12 changelog for the rest.
- 91f219f: Two concurrent ACS requests for one new NameID no longer answer 500 (or reject the second); the second signs in as the user the first created or linked (BEH-EA-245). `@awthaq/test` gains `Rendezvous` for tests that force an interleaving.
- 3f15c9b: `SamlRecords` has a RecordsContract suite (plan 25 ticket 22, ADR-EA-041 decision 9, BEH-EA-315/318):
  
  - A sign-in's SAML session row is one upsert (plan 24 C10). Before, `saveSession` deleted then inserted, so two saves of one session id could race into a primary-key failure (a `StoreUnavailable`), and a reader between the statements saw no row.
  - A connection and its email domains are written as one step: the SQL `create`, `update` and `remove` each run in one transaction, the connection row first. A taken domain rolls the whole write back (no compensating delete), an update no longer writes the row of a connection removed meanwhile, and an update racing a removal cannot deadlock on Postgres.
  - `emailDomains` are answered in ascending order by both adapters (plan 24 R5); the memory adapter kept insertion order.
  - Every operation carries a verdict, with 8-way race cases for `create`, `update`, `remove` and `saveSession` on memory and SQL, Postgres included under `pnpm test:pg`.
  
  Migration: a custom adapter through `@awthaq/saml`'s `SamlRecords` must answer `emailDomains` ascending, make `saveSession` a single upsert, and write a connection with its domains atomically (a taken domain leaves nothing of the create or update).
- 8aba518: SAML first login creates its user through `SignUp` (ADR-EA-038): `BeforeSignUp` vets it, and the user and IdP account are one unit announced only after it commits.
- 2f56ab5: A SAML sign-in completed by a second factor now records `fed` in its `amr`, and a store outage during sign-in answers 503 `StoreUnavailable` instead of a 500 defect.
  
  - `@awthaq/saml`: the `BeforeSessionIssue` divert context carries `amr: ["fed"]`, the same methods the session is issued with, so the two-factor plugin's final session records `["fed", "otp", "mfa"]` instead of `["otp", "mfa"]`. An outage reading the user or minting the session is the typed `StoreUnavailable`.
  - `@awthaq/password`, `@awthaq/passkey`, `@awthaq/oauth`: the sign-in completions no longer `Effect.orDie` `Sessions.issue`, `Users.findById` or the credential-hash reads (ADR-EA-028); a `UserNotFound` / `AccountNotFound` impossible by construction still dies, on that tag only. No Shape or contract changes; the wire answer for an outage becomes 503.
  
  Migration: sessions minted before the fix keep `["otp", "mfa"]` until they end, so a policy gating on `fed` should not assume old two-factor SAML sessions carry it. Clients that retried sign-in only on 500 should also retry 503, and alerting keyed on 500s for sign-in outages should add 503. BEH-EA-245, BEH-EA-261, BEH-EA-088.
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
- Updated dependencies [95c6c09]
- Updated dependencies [bf60ccb]
- Updated dependencies [8fa8c43]
- Updated dependencies [c2a6bfe]
- Updated dependencies [a305c26]
- Updated dependencies [a5927c3]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [1cef4be]
- Updated dependencies [41f57a0]
- Updated dependencies [1a621ba]
- Updated dependencies [fd06299]
- Updated dependencies [c1e437d]
- Updated dependencies [23ec85b]
- Updated dependencies [f4cf736]
- Updated dependencies [05c2ef7]
- Updated dependencies [273f910]
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
- Updated dependencies [22cbfcf]
- Updated dependencies
- Updated dependencies [9a04906]
- Updated dependencies [1cef4be]
- Updated dependencies [b8fb23c]
- Updated dependencies [38ca611]
- Updated dependencies [4d9fed1]
- Updated dependencies [1371d7b]
- Updated dependencies [8665a4a]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [0a0059f]
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
  - @awthaq/organization@0.2.0
