# @awthaq/organization

## 0.2.0

### Minor Changes

- 1cef4be: Organization's authorized interface takes the domain caller instead of the wire principal.
  
  Migration: Organization's authorized methods take `CurrentUser.Caller` (wrap a principal with `CurrentUser.of`); `OrganizationActiveContext.sessionOf` takes a Caller.
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
- bf60ccb: The organization's authorized interface authorizes through one primitive, and every statement-gated endpoint audits a non-member's attempt.
  
  - Every organization-scoped method of `Organization` takes an access proof from one package-private module before it calls a system interface. The order (the organization is active, the caller is a member, the feature gate, the statement) is written once, so a non-member's answer never depends on the endpoint or on an optional feature (ADR-EA-040 decision 6).
  - `removeMember`, `updateMemberRole`, `cancelInvitation` and the seven team writes now record a non-member's attempt as `auth.organization.permissionDenied` with reason `notMember`, as `update`, `delete`, `invite` and the role endpoints already did (PERS-005).
  - A team role held in another organization no longer counts toward a team statement checked under this organization's path. A team write naming another organization's team now answers `403 OrganizationPermissionDenied` to a member lacking the statement at this organization's level (it was `404 TeamNotFound`); nothing was ever written (BEH-EA-284).
  - `OrganizationActor.user` is removed, and `OrganizationActor.Bound.Ceiling(…)` needs `OrganizationActor.CeilingStatements`, which only `OrganizationAuthority` mints. `OrganizationAuthority` gains `scopedStatements`, `scopedCeiling` and `holds`.
  
  Migration: build a user actor with `OrganizationActor.ActorSchema.cases.User.make({ userId, sessionId })` if a system call needs one. Replace `OrganizationActor.Bound.Ceiling({ statements })` with `OrganizationAuthority.ceilingOf(organizationId, roles)`; `Bound.Unbounded()` is unchanged. Expect additional `auth.organization.permissionDenied` audit rows with reason `notMember`.
- 8fa8c43: Organization quotas and team invariants hold under concurrency (plan 25, ADR-EA-041 decision 9). Each is now decided by the record-store write that could break it, atomically on every adapter (memory: one `Ref.modify`; SQL: one transaction holding a per-scope lock on Postgres, `SqlStore.atomically`), and the system module's earlier count only orders errors before the veto:
  
  - `membershipLimit` (`OrganizationMembers.add`, `OrganizationInvitations.accept`) and `organizationLimit` (`OrganizationDirectory.create`): two concurrent requests at `limit - 1` no longer both succeed; the loser answers `MembershipLimitReached` / `OrganizationLimitReached`.
  - The last team (`allowRemovingAllTeams: false`), `maximumTeams` and `maximumMembersPerTeam` (add, roster, invitation acceptance): the loser answers `LastTeamCannotBeRemoved` / `TeamLimitReached` / `TeamMemberLimitReached`. A concurrent removal of the same team answers `TeamNotFound`, not a 500.
  - On Postgres, crossing `moveTeam`s can no longer make a cycle, a team created under a parent being removed can no longer be orphaned, and a member count can no longer go negative (decrements only for rows actually deleted, floored at zero).
  - Invitation transitions are a compare-and-set from `pending` (BEH-EA-286): of an accept, reject, cancel or expiry racing on one invitation exactly one wins, the others answer `InvitationNotPending`, a lost acceptance rolls its membership back, and a cancellation or expiry is announced once. `invitationLimit` and `maximumRolesPerOrganization` hold under concurrency (`InvitationLimitReached`, `RoleLimitReached`).
  - On Postgres, two administrators patching different fields of an organization both keep their change; racing first writes of a session's active context no longer collide; an update racing the removal of an OAuth connection no longer brings it back. A concurrent removal of the same role or organization answers `OrgRoleNotFound` / `OrganizationNotFound`, not a 500.
  - A connection's `emailDomains` are answered sorted ascending by both adapters.
  - The member listing honours `sortDirection` over SQL and orders by `(createdAt, id)` in both adapters; teams list by `(createdAt, id)`.
  
  Migration: a custom record adapter through `@awthaq/organization/records` must implement the new options atomically: `MembershipRecords.create(input, { within?, ownedWithin? })` (refusing `MembershipRecords/LimitReached` / `MembershipRecords/OwnedLimitReached`), `TeamRecords.createTeam(input, { within? })` (`TeamRecords/LimitReached`), `TeamRecords.addTeamMember(input, { within? })` (`TeamRecords/MemberLimitReached`), `TeamRecords.removeTeam(org, id, { keepOne? })` (`TeamRecords/LastTeam`), and take a per-organization lock around team-forest writes on Postgres. `listByOrganization` must order by `(createdAt, id)` in `sortDirection` before paging. `InvitationRecords.updateStatus` is replaced by `transition(org, id, { from: "pending", to })` answering whether it moved; `InvitationRecords.create(input, { pendingWithin? })` (`InvitationRecords/LimitReached`) and `OrgRoleRecords.create(input, { within? })` (`OrgRoleRecords/LimitReached`) are new; `ConnectionRecords` answers `emailDomains` sorted. BEH-EA-283, BEH-EA-286, BEH-EA-287, ADR-EA-041.
- a305c26: Deleting an organization removes the connections that hang off it, in its own transaction (ADR-EA-040, BEH-EA-235). `OrganizationDeletion` is an aggregating registry (like `Erasure.contribute`), exposed by `Organization.layer`; `OrganizationDirectory.delete` runs every contribution's `inTransaction` after its own cascade and every `afterCommit` once the transaction has committed, so a failing contribution rolls the deletion back instead of leaving rows behind. OIDC/OAuth2 connections (`connectionsOnOrganizationDelete`), SAML connections (their domains, SP keys and Single Logout sessions) and SCIM connections (and their mappings, through the new `ScimRecords.removeAllForOrganization`) previously outlived the organization. The OIDC `OrganizationConnectionStore` now refuses an unknown or suspended organization (`InvalidConnection`) and takes an `Actor` on `create`, `update` and `remove`, publishing the new core events `auth.organization.connectionCreated` / `connectionUpdated` / `connectionDeleted` (identifiers only, with the acting user's id when the actor names one; `@awthaq/core`).
  
  Migration: `OrganizationConnections.cleanupOnOrganizationDelete` (an opt-in observe tap whose failures were swallowed) is replaced by `connectionsOnOrganizationDelete`; provide it where the store is. `OrganizationConnectionStore.create(input)` becomes `create(actor, input)`, `update(organizationId, connectionId, patch)` becomes `update(actor, organizationId, connectionId, patch)` and `remove(organizationId, connectionId)` becomes `remove(actor, organizationId, connectionId)` (use `OrganizationActor.application("...")` for application code). `OrganizationConnections.layerStore` now requires the exposed `OrganizationDirectory` and `AuthEvents`. `Saml.layer` and `Scim.layer` now require the `OrganizationDeletion` registry that `Organization.layer` exposes. A custom `ScimRecords` implements `removeAllForOrganization(organizationId)`. A new tenancy table is not needed: no migration.
- a5927c3: The organization row is a system module, `OrganizationDirectory` (`find`, `findActive`, `requireActive`, `isSlugAvailable`, `listForUser`, `listPage`, `create`, `update`, `delete`, `suspend`, `reinstate`), exposed by `Organization.layer` (ADR-EA-040). `create` writes the organization and its creator's membership in one transaction (a failed creation leaves neither) and the creator's membership now fires `AfterAddMember`. `suspend` and `reinstate` take a `PlatformAdminActor`, run the new `BeforeSuspendOrganization` / `AfterSuspendOrganization` and `BeforeReinstateOrganization` / `AfterReinstateOrganization` hook points, and still publish `auth.admin.organizationSuspended` / `organizationUnsuspended`. `AdminTenants` suspends, reinstates and lists through the Directory instead of writing `OrganizationRecords`, so a platform suspension is observable and `@awthaq/qadi`'s `DecisionCacheInvalidationLive` now clears a long-lived decision cache on suspension, reinstatement, a team move and a team-role change. The SAML and SCIM token and connection gates read `OrganizationDirectory.findActive` / `find`. `OrganizationQadi.relationships` reads the Directory.
  
  Migration: `AdminTenantsShape["suspendOrganization"]` and `["unsuspendOrganization"]` (and the `/admin/organizations/:id/suspend` and `/unsuspend` endpoints) can now answer `HookAborted` (`403`) when a `BeforeSuspendOrganization` / `BeforeReinstateOrganization` tap vetoes. `AdminTenants`, `SamlConnections.layerStore`, `Saml.layer` and `ScimAuthenticationLive` require the exposed `OrganizationDirectory` instead of `OrganizationRecords`. A host that installs `DecisionCacheInvalidationLive` must provide `OrganizationHooksLive` (as before) which now includes the four new points. `OrganizationLive` compositions are unchanged. The tenant middleware still reads `OrganizationRecords` directly (a raw read of a suspended organization is deliberate).
- 81d4323: Invitations are a system module, `OrganizationInvitations` (`find`, `findByToken`, `listForOrganization`, `listPendingForOrganization`, `listForUser`, `listForEmail`, `holdsToken`, `create`, `accept`, `reject`, `cancel`), exposed by `Organization.layer` (ADR-EA-040). It owns the emailed capability token (MTI-010), the expiry, the per-inviter quota, the team rules, role names and the `Bound`, the veto and observe points, the mail, and the transaction of an acceptance. The authorized `invite`, `acceptInvitation`, `rejectInvitation`, `cancelInvitation` and the reads delegate; the invitee's acts take the invitee's user id and no actor.
  
  Behaviour: accepting an invitation is one transaction (the membership, the status and the team membership), so a failure no longer leaves a membership with a pending invitation; an invitation cancelled by a re-invite or by the member check publishes `auth.organization.invitationCanceled`; one found expired on acceptance publishes the new core event `auth.organization.invitationExpired` (`@awthaq/core`); a membership created by accepting an invitation (and a team membership it adds) now fires `AfterAddMember` / `AfterAddTeamMember`; a resent invitation runs `AfterCreateInvitation` again; the veto of `cancelInvitation` runs after the caller is authorized (it ran first), while `accept` and `reject` keep veto-first.
  
  Migration: an event subscriber that switches exhaustively on `auth.organization.*` adds `invitationExpired`. A tap on `AfterAddMember` or `AfterAddTeamMember` now also sees invitation acceptances. `Organization.layer` additionally requires `Mailer` and `Users` for the exposed module (both were already required by the plugin).
- 41f57a0: Membership is a system module, `OrganizationMembers` (`add`, `setRoles`, `remove`, `find`, `list`, `listForUser`), exposed by `Organization.layer` (ADR-EA-040, BEH-EA-330). It owns the owner invariant, `membershipLimit`, role names, the grant `Bound`, MTI-003 uniqueness, the veto, the removal cascade (membership, active context, team memberships in one transaction) and the events and observe points, for every caller. The SAML role mapping is `setRoles` with an `IdentityProvider` actor and `ceilingOf` as its `Bound`; SCIM provisioning is `add` with a `Directory` actor and `Unbounded`; the authorized `removeMember`, `updateMemberRole`, `leave` and `listMembers` delegate. `Organization.addMember`, `syncMemberRoles`, `checkRoleCeiling` and `attributesFor` leave `OrganizationShape` (the interface has 41 methods): they are `OrganizationMembers.add`, `OrganizationMembers.setRoles({ ifAbsent: "add" })`, and `OrganizationAuthority.checkRoleCeiling` / `attributesFor`.
  
  Migration: `organization.addMember({ organizationId, userId, role })` becomes `OrganizationMembers.add(OrganizationActor.application("..."), { organizationId, userId, role, bound: OrganizationActor.Bound.Unbounded() })`; `syncMemberRoles({ roles, ceiling })` becomes `OrganizationMembers.setRoles(actor, { roles, bound: yield* OrganizationAuthority.ceilingOf(organizationId, ceiling), ifAbsent: "add" })`. Behaviour: a caller without `member:delete` / `member:update` is now answered `403` before the owner invariant (it was `409` for the last owner, which leaked that fact); setting a member's roles to exactly what they hold is a no-op for HTTP too (no write, veto, event or observer); a veto tap that rewrites the roles is bounded on what is stored. `@awthaq/saml` and `@awthaq/scim` require the exposed `OrganizationMembers` / `OrganizationAuthority` instead of `Organization`'s removed methods.
- fd06299: The record stores move to a sub-path, `@awthaq/organization/records` (ADR-EA-040, BEH-EA-330): `ActiveContextRecords`, `ConnectionRecords`, `InvitationRecords`, `MembershipRecords`, `OrganizationRecords`, `OrgRoleRecords` and `TeamRecords` are no longer exported from the package root. Every write to an `organization_*` table goes through one system module, and no other plugin imports the records (a static guard, `RecordsBoundary.test.ts`, refuses it). `OrganizationMemory` and the system modules stay at the root.
  
  Migration: `import { TeamRecords } from "@awthaq/organization"` becomes `import { TeamRecords } from "@awthaq/organization/records"` (same names). A host that composes its own record layers, a test that arranges rows and a conformance suite use the sub-path.
- f4cf736: The team forest is a system module, `OrganizationTeams` (ADR-EA-040, BEH-EA-330), exposed by `Organization.layer` beside a read-only `OrganizationAuthority` (the one evaluation path the plugin's gating, its role ceilings and `OrganizationQadi` all read). Every team operation takes an explicit `OrganizationActor.Actor` and owns its guards (`teams.enabled`, `maximumTeams`, `maximumMembersPerTeam`, the last-team rule, the parent in the organization), its veto point, one transaction, its events and its observe point; `create` takes `initialMembers` and an `attach` that runs inside the transaction, and `applyRoster` applies a roster change as one unit. The authorized `Organization` team methods are now only visibility, the feature gate, `PermissionEngine` statements and the caller's grant ceiling (`OrganizationActor.Bound`), then a call into the module; their signatures and error unions are unchanged. `OrganizationQadi.relationships` reads `OrganizationAuthority`. `AuthPlugin.layer` counts an `exposes` layer's requirements when it checks that `ports` is complete (`@awthaq/core`).
  
  Migration: every `OrganizationHooks` input (all 20 veto/observe pairs) now carries `actor`, so a tap that constructs an input (a test, `runPluginContractTests({ hooks })`) must add `actor: OrganizationActor.application("...")`; taps that only receive inputs are unaffected. New exports: `OrganizationActor`, `OrganizationAuthority`, `OrganizationTeams`, `OrganizationSystem`. `Organization.layer` now also requires `SqlTransaction` (already a declared port) for the exposed modules.
- 05c2ef7: The organization records are scoped by their organization key, a cross-organization method takes a witness, the client secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - Every method that reads or writes across organizations takes a `TenantScoped.CrossTenant` as its first argument (`OrganizationRecords.listByIds/listPage/setSuspended`, `MembershipRecords.listByUser/deleteAllByUser`, `InvitationRecords.findById/findByTokenHash/listByEmail/listByInviter/countPendingByInviter/removeAllForUser`, `TeamRecords.findTeamByIdAnyOrg/removeUserFromAllTeams`, `ConnectionRecords.findByEmailDomain`, `ActiveContextRecords.deleteAllByUser`); its statement runs under `TenantScoped.lift`, so it still sees every organization inside a request's Postgres RLS transaction. `InvitationRecords.setTokenHash/updateStatus` and the connection-domain deletes now also filter by `organizationId`.
  - `ConnectionRecord.clientSecret` is `Option<SealedColumn.Sealed<string>>` (and `secretRevision` is the compare-only ciphertext fingerprint); `ConnectionInput`/`ConnectionPatch` take a `Redacted` secret. Secrets sealed under the old `organization-oauth-connection:` AAD still open and re-seal on read. `ConnectionRecords.layerMemory/layerSql` require `Encryption`; `OrganizationConnections` and its store no longer do.
  - The records modules, `OrganizationShape`, `OrganizationConnectionStore`, `AdminTenants` and the SAML/SCIM services fail with `StoreUnavailable` instead of dying; the tenant middleware answers it `503`; the SCIM bearer middleware and the SAML metadata/SSO endpoints declare it. `@awthaq/sql` adds `StoreFailure.orConflict` and `TenantScoped.liftOn`, and `orStoreUnavailable` accepts a `RETURNING` that returned no row (a defect).
  
  Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to the methods above, and pass `organizationId` to `InvitationRecords.setTokenHash/updateStatus`; open a connection's secret with `SealedColumn.option(record.clientSecret.value.open)`; provide `Encryption` to `ConnectionRecords`; handle `StoreUnavailable` on the widened service methods. BEH-EA-284, BEH-EA-328.
- 75cc655: `@awthaq/organization` owns its events (ADR-EA-049): the 25 `auth.organization.*` definitions and `auth.admin.organization{Suspended, Unsuspended}` moved from `@awthaq/core` to `OrganizationEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit` by the plugin's system modules and its authorization primitive. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged: `auth.organization.permissionDenied` keeps `attempt: true`, and a suspension row now records `meta.pii: ["reason"]` (rows written before keep falling back to `AuditLog.PRE_ADR_049_PII`). Core now defines 24 events, none of which declares personal data.
  
  Migration: the 25 `AuthEvents.Organization*Event` constants, `AuthEvents.AdminOrganizationSuspendedEvent` and `AuthEvents.AdminOrganizationUnsuspendedEvent` → `OrganizationEvents.<same name>` from `@awthaq/organization`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.organization.*` or the two suspension tags: subscribe with `AuthEvents.on(OrganizationEvents.OrganizationCreatedEvent, …)`, narrow the stream with `AuthEvents.is(OrganizationEvents.OrganizationCreatedEvent)`, decode an audit row with `AuditLog.payloadAs(OrganizationEvents.OrganizationCreatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(OrganizationEvents.OrganizationCreatedEvent)(e)`. A module that uses an organization system module (the connection store, the directory) outside the `Organization` plugin must compose the plugin, or its events are undeclared. ADR-EA-049, BEH-EA-101.
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
- 8665a4a: `Organization.records` is the plugin's record stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.
  
  - The seven stores (`OrganizationRecords`, `MembershipRecords`, `ActiveContextRecords`, `InvitationRecords`, `OrgRoleRecords`, `TeamRecords`, `ConnectionRecords`) are keyed `awthaq/organization/records/<Name>`; `Organization.layer` requires them and the compiler checks the bundle provides every one. `ConnectionRecords` is in the bundle although the plugin layer does not require it itself (it backs `organization_oauth_connection*`).
  
  Migration: code that built a `Context` by the old key string must use the class (`Context.get(context, OrganizationRecords.OrganizationRecords)`). A host replaces the six hand-listed `layerMemory`/`layerSql` layers with `Organization.records.memory` / `Organization.records.sql` (`OrganizationMemory.layer` stays for now and lacks `ConnectionRecords`).
- 0a0059f: `OrganizationMemory` is removed from the package root. `Organization.records.memory` (the plugin's records bundle: the six stores `OrganizationMemory.layer` merged, plus `ConnectionRecords` and `DomainClaims`) replaces it. **Migration:** `OrganizationMemory.layer` becomes `Organization.records.memory`, or, over `TestAuth.layer(Auth.make([Organization]))`, nothing at all.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 7e9834e: Plugins contribute their own retention rules to `Retention.sweep`.
  
  - `@awthaq/core`: new `Retention.contribute({ id, order?, make })` and `Retention.RetentionRegistry` (provided by `Hooks.HooksLive`, like the erasure registry). `Retention.sweep` runs every contribution after the core purges, isolates a failing one, and reports `SweepReport.plugins: ReadonlyArray<{ id, deleted, failed }>`; its requirements gain `RetentionRegistry`. ADR-EA-031 Decision 6 amended (revision 1.4); BEH-EA-337.
  - `@awthaq/saml`: contributes `saml.sessions` and no longer prunes session records inside every sign-in.
  - `@awthaq/device-authorization`: contributes `device_authorization.grants`. `@awthaq/jwt`: contributes `jwt.revocations` (`RevocationStore` gains `purgeExpired`). `@awthaq/organization`: contributes `organization.invitations` (new `invitationRetention`, default 30 days; `InvitationRecords` gains `purgeExpired`). `@awthaq/passkey`: contributes `passkey.challenges`. `@awthaq/webhooks`: contributes `webhooks.deliveries` (the worker keeps its hourly prune).
  
  Migration: a composition that installs one of these plugins must provide `Retention.RetentionRegistry`; every `Auth.make` composition and `Hooks.HooksLive` already do. A host with its own `RevocationStore` or `InvitationRecords` implements `purgeExpired`. SAML session records now age out only when the host runs `Retention.sweep` or `Retention.layerScheduled`; a host that relied on the inline prune must schedule the sweep.
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.
- be42578: Row-level security covers plugin tables (plan 05, ADR-EA-018 decision 10), documented and exercised end to end.
  
  - Opt in with `TenantScope.enableRls({ plugins: auth.tenancy })` (Partitioned tables by their column, Derived tables through their parent's policy) and, for the organization-keyed tables, `includeKeyed: true`. `enableRls()` with no argument still covers only the core tables; `disableRls` drops the `awthaq_tenant` policy from every table that has one. `packages/sql/README.md` and the `TenantMiddleware` header describe the rollout, the non-owner role, the `CrossTenant` witness and `TenantScoped.lift`.
  - Every plugin records suite passes `rls` to `TestAuth.runTenantIsolationTests` (webhooks, admin, organization, saml, scim), so `pnpm run test:pg` proves the database confines an unfiltered statement and a witnessed one is not; `organization/test/TenantMiddleware.test.ts` has a Postgres-only case through `layerWithRls`.
  
  Migration: nothing changes unless you opt in. Opting in is `enableRls({ plugins: auth.tenancy })`; backfill `NULL` `"tenantId"` rows first if they must stay visible inside tenant scopes (ADR-EA-018 Consequences). BEH-EA-233.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 1cef4be: SCIM tokens, organization invitation tokens and verification values are now hashed through `SecretHash.digest`, and every hex encoding goes through `Hmac.toHex`. The stored hashes are byte-identical (pinned by known-answer tests), so existing tokens, invitations and imported scrypt passwords keep working.
  
  Migration: none.
- c2a6bfe: Role endpoints answer a non-member `404` whether or not dynamic access control is enabled, invitations of a suspended organization can no longer be cancelled, read, accepted or rejected, and a suspended organization's active pointers read as none.
  
  - `createRole`, `listRoles`, `getRole`, `updateRole` and `deleteRole` check the caller's membership before the dynamic-access-control gate (the PV-300 order the team endpoints already use). With the feature off (the default), an outsider used to get `403 DynamicAccessControlDisabled` for an existing organization and `404 OrganizationNotFound` for an unknown one, which told any signed-in user which organization ids exist (BEH-EA-284). A non-member's attempt on a role endpoint is now recorded `auth.organization.permissionDenied` with reason `notMember` whether or not the feature is on.
  - `cancelInvitation`, `getInvitation`, `getInvitationByToken`, `acceptInvitation` and `rejectInvitation` (and the system `OrganizationInvitations.accept` / `reject`) answer `404 InvitationNotFound` while the invitation's organization is suspended, and write nothing. They used to answer `204`/`200`, and an acceptance created a membership in the suspended organization (BEH-EA-237). The invitation stays pending, so it works again after reinstatement.
  - `getActive` (`GET /organization/active`) reads `activeOrganizationId: null` and `activeTeamId: null` while the active organization (or the active team's organization) is suspended. The row is not cleared, so reinstatement restores the pointers. `setActiveTeam` for a team of a suspended organization answers `404 TeamMembershipNotFound` (BEH-EA-237).
  
  Migration: a client that relied on `403 DynamicAccessControlDisabled` to learn that the feature is off must ask as a member. An invitation flow that meets a suspended organization now sees `InvitationNotFound`, already in every one of these error unions. Nothing else changes.
- 3917b38: Organization events say who acted (ADR-EA-040, BEH-EA-290, plan 04 F11). Every `auth.organization.*` event except `permissionDenied` gains an optional `actorUserId`, and the audit actor of those events is now that field: `memberAdded`, `memberRemoved`, `memberRoleUpdated`, `invitationAccepted` and the team-member events used to record the *subject* as the actor, so "who removed X" was lost. The system modules publish `actorUserId` from their `Actor` (the user, or the platform administrator; a directory, an identity provider or the application leaves it absent). `auth.organization.created` records the actor rather than the creator (`creatorUserId` is unchanged).
  
  Migration: an event subscriber (a webhook consumer, an `EventRelay` transport) that decodes organization events sees an optional `actorUserId`. An audit query that filtered `actorUserId` on `auth.organization.memberRemoved` and friends to find "what happened to this user" must read the event payload's `userId` instead; `actorUserId` is now the actor.
- 1cef4be: The memory adapter orders organizations with the same id comparison it pages with.
  
  Migration: none.
- 1a621ba: Removing, demoting or leaving can no longer leave an organization without an owner when two such requests race; a concurrent second removal of one member answers 404, not 500. `MembershipRecords.remove` and `updateRole` now refuse with the new `MembershipRecordLastOwner` (`"MembershipRecords/LastOwner"`) when the write would take `owner` from the organization's only owner, deciding atomically on every adapter (memory: one `Ref.modify`; SQL: one transaction that takes a per-organization advisory lock on Postgres first). `removeAllForOrganization` and `deleteAllByUser` stay unguarded by design (organization deletion; erasure).
  
  Migration: A custom `MembershipRecords` adapter (through `@awthaq/organization/records`) must refuse `MembershipRecordLastOwner` atomically in `remove` and `updateRole`. On Postgres, take a lock per organization before counting owners; a transaction alone is not enough under READ COMMITTED. BEH-EA-285, ADR-EA-041.
- c1e437d: Dynamic roles and a session's active context are system modules, `OrganizationRoles` and `OrganizationActiveContext`, exposed by `Organization.layer` (ADR-EA-040). `OrganizationRoles` owns the `dynamicAccessControl.enabled` gate, the reserved names (RZS-005), the grant `Bound` over a role's statements, `maximumRolesPerOrganization`, the veto and observe points and the events; `OrganizationActiveContext` owns the per-session pointers (MTI-001), the suspension rule and the re-validation on read (CWM-003). The authorized `createRole`, `listRoles`, `getRole`, `updateRole`, `deleteRole`, `getActiveMember`, `getActiveMemberRole`, `setActive`, `getActive` and `setActiveTeam` delegate with unchanged signatures and error unions. `Organization.ts` is now the plugin class, the authorized interface and its implementation (838 lines, from 3,879) and reads no records of its own beyond a membership lookup through `OrganizationMembers`.
  
  Migration: additive; new exports `OrganizationRoles`, `OrganizationActiveContext`. No behaviour change for HTTP callers.
- 23ec85b: The system `OrganizationInvitations.cancel` refuses a suspended organization's invitation with `InvitationNotFound` (checked before its status) and writes, vetoes and announces nothing, as the `cancelInvitation` endpoint already did (BEH-EA-237). A host, SCIM or administrative caller that cancelled such an invitation directly now gets the not-found answer; reinstate the organization first.
- 273f910: Every veto point in the organization plugin is named by its class (`HookPoint.aborted(OrganizationHooks.BeforeX)`) instead of a hand-typed string id, so a misspelt id cannot compile. `HookAborted.point` values are unchanged. The plugin's configuration, handlers, migrations and personal-data contributions moved to their own files (`OrganizationConfig`, `OrganizationHandlers`, `OrganizationMigrations`, `OrganizationPersonalData`, `OrganizationShape`) and the domain errors to `OrganizationErrors`; `OrganizationApi` and `Organization` re-export every name they exported before.
  
  Migration: none.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- 22cbfcf: Fix: on libSQL, a domain another OIDC connection already holds answers `ConnectionDomainTaken`, not 503 (`StoreUnavailable`). A SAML domain insert that fails a constraint other than a unique one is no longer reported as `SamlDomainTaken`; it is a store failure. Both now classify through `StoreFailure.isUniqueViolation` (ADR-EA-028, ADR-EA-041).
  
  Migration: none.
- 9a04906: Postgres: racing session inserts and step-ups no longer overshoot or exhaust under contention, and a domain claim's writes stay under row-level security.
  
  - `@awthaq/sql`: `SessionStore.insert` with a `maxLive` cap takes a per-user advisory transaction lock, so concurrent logins serialize and the cap holds exactly (SMS-003); `SessionStore.reauthenticate` takes a per-session lock, so N concurrent step-ups all land (THS-003).
  - `@awthaq/organization`: `DomainClaims.claim` lifts row-level security only for the owner read, not for its inserts and deletes.
  - `@awthaq/test`: `TestSql.prepareRlsProbe` readies a suite's schema for an RLS probe; `runTenantIsolationTests` uses it.
- 1cef4be: Built against `@qadi/core`, `@qadi/http` and `@qadi/react` 0.12 (the peer ranges move from `^0.11.0` to `^0.12.0`). `@awthaq/qadi`'s `ObligationHandlers.reauth` is an `ObligationHandler` of 0.12, so it takes the `{ question, decision }` discharge and reads `decision.obligations`; `onObligations: ObligationHandlers.reauth` is unchanged. `@awthaq/react` re-exports the new `useQuestions` hook (the devtools dock feed, `useDevtoolsFeed` and `runtimeLayer`, stays on `@qadi/react`).
  
  Migration: a host with an endpoint that declares neither `RequiredPermission` nor `publicEndpoint` (or that `RequirePermission` does not cover) now fails at startup, when `guardApi` is built, with `AccessNotDeclared` or `RequirePermissionNotAttached`, instead of serving a 500 per request: annotate the endpoint. A direct call `ObligationHandlers.reauth([...obligations])` becomes `ObligationHandlers.reauth({ question, decision })`; guard a Path B `HttpApi` with `guardApi(Api)` (replaces `RequirePermissionLive` and `registerApi`, provide `PermissionRegistryLive` once where the stack is composed) and see the `@qadi/http` 0.12 changelog for the rest.
- 5f11353: New `SqlStore.atomically(sql, key)`: runs one store primitive's read-modify-write in one transaction (a savepoint inside a caller's) that first takes an exclusive lock named `key`, `pg_advisory_xact_lock(hashtextextended(key, 0))` on Postgres, held until the outermost transaction ends. SQLite takes no lock (its client already runs one transaction at a time). It is how a record store keeps an invariant over several rows atomic under READ COMMITTED (ADR-EA-041 decision 9). `MembershipRecords`' SQL `remove`/`updateRole` now take their per-organization lock through it instead of an inline statement; the lock key is unchanged. `StoreFailure.orConflict` maps a SQLite primary-key clash to the domain conflict, like Postgres, and a test now pins it on the real driver.
  
  Migration: none (additive).
- 40a32a1: `Organization` and `DeviceAuthorization` declare the hook points they own (`hookPoints`), so a composition harness can provide them once. No behaviour change.
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
- Updated dependencies [ff622f0]
- Updated dependencies [08bd515]
- Updated dependencies [e073887]
- Updated dependencies [9ee6c39]
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
- Updated dependencies [76ebf1f]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [6cebb31]
- Updated dependencies [d82b7a4]
- Updated dependencies [919bd4d]
- Updated dependencies [28a78b0]
- Updated dependencies [0e74d59]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [71a4af0]
- Updated dependencies [01b82ea]
- Updated dependencies [5859d43]
- Updated dependencies [7dc7f4b]
- Updated dependencies [1a206af]
- Updated dependencies [1cef4be]
- Updated dependencies [401a719]
- Updated dependencies [fc20f74]
- Updated dependencies [2be1097]
- Updated dependencies [4cd6174]
- Updated dependencies [6a06f06]
- Updated dependencies [6d797b0]
- Updated dependencies [b0b6a4d]
- Updated dependencies [2f56ab5]
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
  - @awthaq/oauth@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
