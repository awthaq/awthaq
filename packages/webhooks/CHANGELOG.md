# @awthaq/webhooks

## 0.2.0

### Minor Changes

- f831b6c: Finishes `@awthaq/webhooks` and `@awthaq/saml` (BEH-EA-308 through 318, ADR-EA-036).
  
  **Webhooks.** The event envelope and `AuditLogRecord` carry `tenantId` (the value the audit row already stored); endpoints belong to a tenant, hear only that tenant's events and are administered inside that tenant's scope (`platformEndpointsHearAllTenants` opts the platform's own endpoint into every tenant's); `POST .../endpoints/:id/test` sends a signed synthetic `webhook.test` event through the real delivery path (one attempt, never counted against the endpoint); every successful administrative mutation publishes an `auth.webhooks.*` audit event of identifiers; per-endpoint custom headers (values sealed, never returned); and the connection is pinned to the address that was checked (`HostResolver.pin`, `PinnedHttp` in `@awthaq/ports`, `WebhookTransport.layerNodePinned`), closing DNS rebinding.
  
  **SAML.** Signed AuthnRequests with an SP key stored sealed (`SamlSpKeys`); Single Logout in both directions over Redirect and POST, revoking with the new session reason `federatedLogout`; the `saml.admin` group (fail-closed, tenant-scoped connection CRUD, IdP metadata import from XML or a URL through the pinned fetcher, refresh, SP key rotation) and `saml.account` (`POST /auth/saml/logout`); role mapping under a `canGrant` ceiling (`Organization.checkRoleCeiling`/`syncMemberRoles`); and the `Sso` dispatcher. IdP-initiated login and encrypted assertions stay refused (ADR-EA-036).
  
  Migration: `Webhooks.Webhooks.background()` requires a `WebhookTransport` instead of an `HttpClient` (provide `WebhookTransport.layerNodePinned`, or `WebhookTransport.layerHttpClient` over your client, which cannot pin); `EventMetadata`/`Published` gain a required `tenantId: Option<string>` (hand-built envelopes add `tenantId: Option.none()`); `AuditLogRecord` gains `tenantId`; `EndpointRecord` gains `tenantId`, `headers` and `headerNames`, and `EndpointDto` gains `tenantId` and `headerNames`; the plugin migrations `add_webhooks_endpoint_tenant`, `add_webhooks_endpoint_headers`, `add_saml_connection_signing_logout_roles`, `create_saml_sp_key` and `create_saml_session` are appended; `SamlConnections.layerStore` now requires `SamlSpKeys` (which requires `Encryption`) and the `Organization` service, and `Saml.Saml.layer` requires `SamlSpKeys`, `SamlMetadataFetcher` and the admin/user authentication; `SamlConfig.rateLimits` gains `slo` and `sso`; `SessionRevocationReason` gains `federatedLogout`; `OrganizationShape` gains `checkRoleCeiling` and `syncMemberRoles`; `HostResolver.refusal` is now `HostResolver.pin` underneath.
- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.

### Patch Changes

- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- Updated dependencies
- Updated dependencies [d7351b7]
- Updated dependencies [3514b28]
- Updated dependencies [cb155d4]
- Updated dependencies [f831b6c]
- Updated dependencies [e073887]
- Updated dependencies
- Updated dependencies [4688890]
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies [5d5b3c6]
- Updated dependencies
  - @awthaq/core@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/sql@0.2.0
