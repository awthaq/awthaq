---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/organization": minor
"@awthaq/webhooks": minor
"@awthaq/saml": minor
---

Finishes `@awthaq/webhooks` and `@awthaq/saml` (BEH-EA-299 through 309, ADR-EA-036).

**Webhooks.** The event envelope and `AuditLogRecord` carry `tenantId` (the value the audit row already stored); endpoints belong to a tenant, hear only that tenant's events and are administered inside that tenant's scope (`platformEndpointsHearAllTenants` opts the platform's own endpoint into every tenant's); `POST .../endpoints/:id/test` sends a signed synthetic `webhook.test` event through the real delivery path (one attempt, never counted against the endpoint); every successful administrative mutation publishes an `auth.webhooks.*` audit event of identifiers; per-endpoint custom headers (values sealed, never returned); and the connection is pinned to the address that was checked (`HostResolver.pin`, `PinnedHttp` in `@awthaq/ports`, `WebhookTransport.layerNodePinned`), closing DNS rebinding.

**SAML.** Signed AuthnRequests with an SP key stored sealed (`SamlSpKeys`); Single Logout in both directions over Redirect and POST, revoking with the new session reason `federatedLogout`; the `saml.admin` group (fail-closed, tenant-scoped connection CRUD, IdP metadata import from XML or a URL through the pinned fetcher, refresh, SP key rotation) and `saml.account` (`POST /auth/saml/logout`); role mapping under a `canGrant` ceiling (`Organization.checkRoleCeiling`/`syncMemberRoles`); and the `Sso` dispatcher. IdP-initiated login and encrypted assertions stay refused (ADR-EA-036).

Migration: `Webhooks.Webhooks.background()` requires a `WebhookTransport` instead of an `HttpClient` (provide `WebhookTransport.layerNodePinned`, or `WebhookTransport.layerHttpClient` over your client, which cannot pin); `EventMetadata`/`Published` gain a required `tenantId: Option<string>` (hand-built envelopes add `tenantId: Option.none()`); `AuditLogRecord` gains `tenantId`; `EndpointRecord` gains `tenantId`, `headers` and `headerNames`, and `EndpointDto` gains `tenantId` and `headerNames`; the plugin migrations `add_webhooks_endpoint_tenant`, `add_webhooks_endpoint_headers`, `add_saml_connection_signing_logout_roles`, `create_saml_sp_key` and `create_saml_session` are appended; `SamlConnections.layerStore` now requires `SamlSpKeys` (which requires `Encryption`) and the `Organization` service, and `Saml.Saml.layer` requires `SamlSpKeys`, `SamlMetadataFetcher` and the admin/user authentication; `SamlConfig.rateLimits` gains `slo` and `sso`; `SessionRevocationReason` gains `federatedLogout`; `OrganizationShape` gains `checkRoleCeiling` and `syncMemberRoles`; `HostResolver.refusal` is now `HostResolver.pin` underneath.
