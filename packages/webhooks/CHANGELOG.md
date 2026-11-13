# @awthaq/webhooks

## 0.2.0

### Minor Changes

- 1cef4be: The webhooks admin operations take `CurrentUser.Caller` instead of `Api.UserPrincipal`.
  
  Migration: the webhooks admin operations take CurrentUser.Caller; pass CurrentUser.of(principal) or yield* CurrentUser.current.
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 14bc1bc: The ban note (`auth.admin.userBanned.reason`) and the organization suspension note (`auth.admin.organizationSuspended.reason`) are personal data: they are blanked in the audit trail when the person is erased and are no longer sent in webhook `data`.
  
  Migration: a webhook receiver that read `data.reason` on `auth.admin.userBanned` or `auth.admin.organizationSuspended` must read the note through the admin API instead. ADR-EA-029, BEH-EA-277, BAM-005.
- f831b6c: Finishes `@awthaq/webhooks` and `@awthaq/saml` (BEH-EA-308 through 318, ADR-EA-036).
  
  **Webhooks.** The event envelope and `AuditLogRecord` carry `tenantId` (the value the audit row already stored); endpoints belong to a tenant, hear only that tenant's events and are administered inside that tenant's scope (`platformEndpointsHearAllTenants` opts the platform's own endpoint into every tenant's); `POST .../endpoints/:id/test` sends a signed synthetic `webhook.test` event through the real delivery path (one attempt, never counted against the endpoint); every successful administrative mutation publishes an `auth.webhooks.*` audit event of identifiers; per-endpoint custom headers (values sealed, never returned); and the connection is pinned to the address that was checked (`HostResolver.pin`, `PinnedHttp` in `@awthaq/ports`, `WebhookTransport.layerNodePinned`), closing DNS rebinding.
  
  **SAML.** Signed AuthnRequests with an SP key stored sealed (`SamlSpKeys`); Single Logout in both directions over Redirect and POST, revoking with the new session reason `federatedLogout`; the `saml.admin` group (fail-closed, tenant-scoped connection CRUD, IdP metadata import from XML or a URL through the pinned fetcher, refresh, SP key rotation) and `saml.account` (`POST /auth/saml/logout`); role mapping under a `canGrant` ceiling (`Organization.checkRoleCeiling`/`syncMemberRoles`); and the `Sso` dispatcher. IdP-initiated login and encrypted assertions stay refused (ADR-EA-036).
  
  Migration: `Webhooks.Webhooks.background()` requires a `WebhookTransport` instead of an `HttpClient` (provide `WebhookTransport.layerNodePinned`, or `WebhookTransport.layerHttpClient` over your client, which cannot pin); `EventMetadata`/`Published` gain a required `tenantId: Option<string>` (hand-built envelopes add `tenantId: Option.none()`); `AuditLogRecord` gains `tenantId`; `EndpointRecord` gains `tenantId`, `headers` and `headerNames`, and `EndpointDto` gains `tenantId` and `headerNames`; the plugin migrations `add_webhooks_endpoint_tenant`, `add_webhooks_endpoint_headers`, `add_saml_connection_signing_logout_roles`, `create_saml_sp_key` and `create_saml_session` are appended; `SamlConnections.layerStore` now requires `SamlSpKeys` (which requires `Encryption`) and the `Organization` service, and `Saml.Saml.layer` requires `SamlSpKeys`, `SamlMetadataFetcher` and the admin/user authentication; `SamlConfig.rateLimits` gains `slo` and `sso`; `SessionRevocationReason` gains `federatedLogout`; `OrganizationShape` gains `checkRoleCeiling` and `syncMemberRoles`; `HostResolver.refusal` is now `HostResolver.pin` underneath.
- 4f65d9e: The readers of "every tag" read the composition's event registry (ADR-EA-049). `@awthaq/webhooks` validates endpoint filters against `AuthEvents.EventRegistry` (core's events plus every composed plugin's: provide `auth.eventsLayer`, as `AuthHost.layer` does), drops the personal-data fields that registry declares for each event, and does not enqueue an event whose tag the registry does not hold (logged as `auth.webhooks.unknownEvent`): without its definition its personal-data fields are unknown. `@awthaq/core`'s `Retention` refuses a rule tag that is not an event of the composition with `Defects/InvalidConfiguration` (at `sweep`, and when `layerScheduled` is built).
  
  Migration: `WebhookPayload.knownEventTags` is removed; read `AuthEvents.EventRegistry`'s `tags`. `WebhookPayload.unknownPattern(patterns, tags)` and `WebhookPayload.toBody(event, options, pii)` take the registry's tags and the event's `piiFieldsOf`. A host composing without `AuthHost.layer` provides `auth.eventsLayer` to the webhooks plugin and its background relay, or filters naming a plugin's events are refused and those events are not delivered. A Retention rule must name a tag of the composition. BEH-EA-277, BEH-EA-278, ADR-EA-049.
- 93f2469: `@awthaq/webhooks` owns its events (ADR-EA-049): the five `auth.webhooks.*` definitions moved from `@awthaq/core` to `WebhookEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. An endpoint filter naming `auth.webhooks.*` resolves through the composed registry, which always holds them when webhooks serves.
  
  Migration: `AuthEvents.WebhookEndpointCreatedEvent`, `AuthEvents.WebhookEndpointUpdatedEvent`, `AuthEvents.WebhookSecretRotatedEvent`, `AuthEvents.WebhookEndpointDeletedEvent` and `AuthEvents.WebhookTestQueuedEvent` → `WebhookEvents.<same name>` from `@awthaq/webhooks`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.webhooks.*`: subscribe with `AuthEvents.on(WebhookEvents.WebhookEndpointCreatedEvent, …)`, narrow the stream with `AuthEvents.is(WebhookEvents.WebhookEndpointCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(WebhookEvents.WebhookEndpointCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(WebhookEvents.WebhookEndpointCreatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 9e6302f: `AuthPlugin.Service` takes an optional `sealedColumns` (the `SealedColumn.column` declarations of the plugin's own tables), `Auth.make` refuses a column on a table the plugin does not own or declared twice (`Auth/SealedColumnDeclarationInvalid`), and `auth.sealedColumns` lists every one, so a rotation sweep cannot forget the TOTP secret or a signing key: `SealedColumn.sweepDeployed({ also: auth.sealedColumns })`. The webhooks, organization, saml, jwt and two-factor plugins declare their seven columns (ADR-EA-019 rev 1.3, BEH-EA-339).
  
  Migration: none (the field is optional). A plugin that seals a column should declare it.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
- 288a5de: `Webhooks.records` is the plugin's record store as one matched `{ memory, sql }` bundle, and the store's service key gains the `/records/` segment.
  
  - `WebhookRecords` is keyed `awthaq/webhooks/records/WebhookRecords`; the bundle provides it over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. The `MemoryEnvelopes` test seam is not part of the bundle. `WebhookTransport` stays a host-provided adapter (it is the delivery worker's, not a record store).
  
  Migration: code that built a `Context` by the old key string must use the class. A host replaces `WebhookRecords.layerMemory` / `WebhookRecords.layerSql` with `Webhooks.records.memory` / `Webhooks.records.sql`.
- 6a28c4d: `Persistence.memory` and `Persistence.sql()` provide the event relay's position, so `EventRelay.layer` and `Webhooks.Webhooks.background()` need nothing else for it; a cursor-store outage is `StoreUnavailable` instead of a defect, and a busy cursor write is retried instead of redelivering the batch (ADR-EA-028). The position only moves forward, so relays sharing a name no longer pull each other back (ADR-EA-030 rev 1.2).
  
  Migration: delete `EventRelay.layerCursorSql` / `EventRelay.layerCursorMemory` and `Repositories.RelayCursorRepositoryLive` from your composition (the bundle provides the store); `EventRelay.RelayCursorStore` is now `RelayCursorStore.RelayCursorStore` from `@awthaq/ports`, and its `set(name, id)` is `advance({ name, lastEventId, at })`. A custom implementation must make `advance` monotonic and pass `StoreContract.relayCursor`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 8b53465: Webhooks: `secret`, `previousSecret` and `headers` are `SealedColumn`s, and the records fail with `StoreUnavailable` instead of dying (plan 05 phase 4).
  
  - `WebhookRecords` accepts plaintext `Redacted` values (`createEndpoint`, `setSecrets`) and hands out `Sealed` values (`EndpointRecord.secret`, `previousSecret`, `headers`); the AAD is `webhooks_endpoint:<id>:<column>`, envelopes under the old `webhooks-endpoint:<id>:<field>` spelling or a retired key still open and are re-sealed on read. `WebhookSecrets.aad`, `seal` and `sealHeaders` are removed; `open` and `openHeaders` no longer take an `Encryption`.
  - Every `WebhookRecordsShape` member gains `StoreUnavailable` in its error channel (the SQL adapter's `Effect.orDie` is gone); `WebhooksShape` methods gain it too, and the admin endpoints answer 503 behind `AdminAuthentication`. A failed `claimDue` is logged and retried on the next worker tick. `enqueue` and `drainDue` can fail with `StoreUnavailable`.
  - `Webhooks` and `WebhookDelivery` no longer require `Encryption`; `WebhookRecords.layerMemory` and `layerSql` do. `layerMemory` also provides `WebhookRecords.MemoryEnvelopes`, the test seam the sealed-column suite uses.
  
  Migration: custom `WebhookRecords` implementations hand out `Sealed` values and take plaintext secrets and headers; replace `WebhookSecrets.seal`/`sealHeaders`/`aad` with the records. Provide `Encryption` to the records layer (`Layer.provide`), not to `Webhooks`. Stored secrets re-seal on read; run `SealedColumn.sweep` per column to finish the rest. BEH-EA-276, BEH-EA-324, BEH-EA-325.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 3b99770: An event's actor and personal-data fields are declared with its schema (`defineEvent(tag, fields, { actor, pii })` inside core), and the audit trail reads them from there instead of a 92-case switch and a separate `PII_FIELDS` table. New: `AuthEvents.eventTags` (every publishable tag), `AuthEvents.actorOf(event)` (who acted, as the audit row records it), `AuthEvents.piiFieldsOf(tag)`. Fixed: the in-memory `AuditLog`'s erasure no longer blanks free text on rows that do not name the erased user. No change to any stored or delivered payload.
  
  Migration: `AuthEvents.PII_FIELDS` is removed; replace `AuthEvents.PII_FIELDS[tag] ?? []` with `AuthEvents.piiFieldsOf(tag)`. ADR-EA-029 (rev 1.1), BEH-EA-101, BEH-EA-277.
- 5a3998d: The audit log no longer needs the event set (ADR-EA-049). `AuditLog.record(event, definition)` writes an event through its own definition (core's when none is given): the actor column, and the fields it declares as personal data recorded with the row (`meta.pii`, only when it declares some; every other row is unchanged). A row whose tag core does not define is read as an `AuthEvents.ForeignEvent` (`{ _tag: "awthaq.foreignEvent", tag, fields }`) instead of failing with `AuditLogDecodeError`, so a removed plugin's history never stops `list`, `replay`, the relay or a data export; `AuditLog.payloadAs(definition)` decodes it. Erasure blanks a row's recorded `meta.pii`, and for rows written before this release the fields the three personal-data events declared then (`AuditLog.PRE_ADR_049_PII`). `toPublished` unwraps a foreign record, and the relay delivers it as published.
  
  Migration: `AuditLogRecord.eventTag` is a `string`, and `payload` is `AuthEvent | AuthEvents.ForeignEvent`: narrow on `payload._tag`, or decode a plugin's row with `AuditLog.payloadAs(definition)`. `EventTransport.deliver` receives `ReadonlyArray<AuthEvents.PublishedAny>`. The tag filters of `AuditLog.list`/`replay`/`purge`, `EventRelay`'s `eventTag` and Retention's `AuditRetentionRule.tags` take `string`. `AuthEvents.encodeEvent` is removed (the audit log encodes through each event's definition: `Schema.encodeEffect(definition)`). `WebhookPayload.toBody`/`subjectUserId` accept `AuthEvents.PublishedAny`. ADR-EA-049, ADR-EA-029, ADR-EA-030, BEH-EA-100.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- 1cef4be: Built against `@qadi/core`, `@qadi/http` and `@qadi/react` 0.12 (the peer ranges move from `^0.11.0` to `^0.12.0`). `@awthaq/qadi`'s `ObligationHandlers.reauth` is an `ObligationHandler` of 0.12, so it takes the `{ question, decision }` discharge and reads `decision.obligations`; `onObligations: ObligationHandlers.reauth` is unchanged. `@awthaq/react` re-exports the new `useQuestions` hook (the devtools dock feed, `useDevtoolsFeed` and `runtimeLayer`, stays on `@qadi/react`).
  
  Migration: a host with an endpoint that declares neither `RequiredPermission` nor `publicEndpoint` (or that `RequirePermission` does not cover) now fails at startup, when `guardApi` is built, with `AccessNotDeclared` or `RequirePermissionNotAttached`, instead of serving a 500 per request: annotate the endpoint. A direct call `ObligationHandlers.reauth([...obligations])` becomes `ObligationHandlers.reauth({ question, decision })`; guard a Path B `HttpApi` with `guardApi(Api)` (replaces `RequirePermissionLive` and `registerApi`, provide `PermissionRegistryLive` once where the stack is composed) and see the `@qadi/http` 0.12 changelog for the rest.
- 1371d7b: The webhooks admin group's per-administrator rate limit is declared as a `rateLimitRules` table and spent through `RateLimits.budget` (plan 06). It used to be enforced without being declared or registered; it now appears in `awthaq plugin list --rules`, the manifest and `RateLimitsRegistry.registered`. `WebhooksConfig.adminRate` is unchanged and still read per request (EP-007); the breach event still reports the admin action as its endpoint. Outbound delivery pacing (`webhooks:deliver:<endpointId>`) is unchanged: it shapes outbound traffic and stays a raw `RateLimiter.consume`.
  
  Migration: the admin bucket is renamed (`webhooks:admin:<userId>` becomes `ratelimit:webhooks.admin.admin:user:<userId>`), so a deploy resets the live admin counters once; entries in a shared store expire within one minute.
- 7e9834e: Plugins contribute their own retention rules to `Retention.sweep`.
  
  - `@awthaq/core`: new `Retention.contribute({ id, order?, make })` and `Retention.RetentionRegistry` (provided by `Hooks.HooksLive`, like the erasure registry). `Retention.sweep` runs every contribution after the core purges, isolates a failing one, and reports `SweepReport.plugins: ReadonlyArray<{ id, deleted, failed }>`; its requirements gain `RetentionRegistry`. ADR-EA-031 Decision 6 amended (revision 1.4); BEH-EA-337.
  - `@awthaq/saml`: contributes `saml.sessions` and no longer prunes session records inside every sign-in.
  - `@awthaq/device-authorization`: contributes `device_authorization.grants`. `@awthaq/jwt`: contributes `jwt.revocations` (`RevocationStore` gains `purgeExpired`). `@awthaq/organization`: contributes `organization.invitations` (new `invitationRetention`, default 30 days; `InvitationRecords` gains `purgeExpired`). `@awthaq/passkey`: contributes `passkey.challenges`. `@awthaq/webhooks`: contributes `webhooks.deliveries` (the worker keeps its hourly prune).
  
  Migration: a composition that installs one of these plugins must provide `Retention.RetentionRegistry`; every `Auth.make` composition and `Hooks.HooksLive` already do. A host with its own `RevocationStore` or `InvitationRecords` implements `purgeExpired`. SAML session records now age out only when the host runs `Retention.sweep` or `Retention.layerScheduled`; a host that relied on the inline prune must schedule the sweep.
- 52ed4bc: `maxEndpoints` holds under concurrency (plan 25, ADR-EA-041 decision 9, BEH-EA-281/309). `Webhooks.createEndpoint` keeps its early count, so a full tenant is refused before the DNS lookup, but the decision is now `WebhookRecords.createEndpoint(input, { within })`, which counts the tenant's endpoints and inserts as one step (memory: one `Ref.modify`; SQL: one transaction under the per-tenant lock `webhooks_endpoint:tenant:<tenant>` on Postgres). Concurrent registrations at `maxEndpoints - 1` store one; the rest answer `WebhookEndpointLimitReached`.
  
  - An administrator's PATCH racing the worker's failure count keeps both: `updateEndpoint` writes only the patched columns in one statement, disabling no longer writes `consecutiveDead` back, and re-enabling resets it in the same statement.
  - `deleteEndpoint` removes the endpoint and its deliveries in one transaction, so a failure between the two no longer leaves orphan deliveries.
  - A test ping whose endpoint is deleted while it is queued answers `WebhookEndpointNotFound` (404), not a defect.
  - `layerMemory`'s `claimDue` hands claimed rows out as leased (`nextAttemptAt` is the lease's end), like `layerSql`.
  
  Migration: a custom `WebhookRecords` adapter (`WebhookRecords.WebhookRecordsShape`, exported from `@awthaq/webhooks`) must accept `createEndpoint(input, { within? })` and, when `within` is given, refuse with `WebhookRecordLimitReached` (`"WebhookRecords/LimitReached"`) once the ambient tenant has that many endpoints, counting and inserting atomically. `updateEndpoint` and `setDisabled` must not write columns they were not asked to change, and `deleteEndpoint` must remove the endpoint and its deliveries together.
- a60ad20: An event relayed while an endpoint is being deleted no longer leaves an orphaned delivery row: `WebhookRecords.enqueue` stores a row only while its endpoint exists (memory: inside the same `Ref.modify`; SQL: per row, a transaction that takes the endpoint row's key-share lock on Postgres before inserting). A custom `WebhookRecords` adapter should skip rows whose endpoint is gone in the same way (BEH-EA-281).
- 493c0fd: Webhooks tenant isolation moves from the service into the records store (plan 05, BEH-EA-309). `webhooks_endpoint` was read tenant-blind and the service filtered every tenant's rows in memory, so one missed check was a cross-tenant mutation and RLS could not back it up.
  
  - `WebhookRecords` stamps `createEndpoint` with the ambient tenant (it no longer takes `tenantId`) and confines `findEndpoint`, `listEndpoints`, `updateEndpoint`, `setSecrets`, `setDisabled`, `deleteEndpoint`, `findDelivery`, `listDeliveries` and `redrive` to it, in SQL and in memory. The relay and the worker, which run with no tenant, call `listEnabledEndpoints`, `findEndpointForDelivery`, `claimDue`, `markSucceeded`, `reschedule`, `defer`, `markDead`, `bumpDead`, `clearDead`, `disableFailing`, `pruneFinished`, `deleteBySubject` and `listBySubject` with a `TenantScoped.CrossTenant` witness.
  - `Webhooks` no longer filters in the service; the erasure and export contributions present their own witness.
  
  Migration: a host or test with its own `WebhookRecordsShape` implementation adds the witness parameter to the relay methods listed above, gains `listEnabledEndpoints`, `findEndpointForDelivery` and `disableFailing`, and drops `tenantId` from `createEndpoint` (register the endpoint inside `Tenant.withTenant(id)`). Code that read a tenant's endpoints or deliveries with no tenant in scope now sees only the platform's.
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
