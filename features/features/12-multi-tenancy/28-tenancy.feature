# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# P20a (AH-003 / decision 36, tenancy follow-up): authored against the implemented tenancy
# surface — `@awthaq/ports` `Tenant`, `@awthaq/sql` `TenantScope` and the stamped repositories,
# `@awthaq/organization` `tenantMiddleware*`, `@awthaq/oauth` connections and the suspension
# state `@awthaq/admin` `AdminTenants` flips. Stamping and the global identity directory run
# over a real in-memory SQLite database migrated by core's own migrations; the organization
# rules run over the plugin's memory records; the middleware runs as a real router middleware
# behind a web handler. Postgres row-level security needs a real Postgres and is covered by the
# `pnpm run test:pg` suite: those scenarios are pruned with that rationale.

@multi-tenancy @tenancy
Feature: Multi-Tenancy

  # BEH-EA-230 — spec/behaviors/28-tenancy.md; see also ADR-EA-018
  @BEH-EA-230
  Rule: The tenant is an ambient reference that defaults to none

    @REQ-EA-814
    Scenario: A fiber that was never given a tenant reads none
      Given no tenant is provided
      When the ambient tenant is read
      Then the ambient tenant is none

    @REQ-EA-815
    Scenario: withTenant provides the tenant for its own effect and nothing after it
      Given no tenant is provided
      When the ambient tenant is read inside "withTenant" for "tenant-a"
      Then the ambient tenant read inside is "tenant-a"
      And the ambient tenant read afterwards is none

    @REQ-EA-816
    Scenario: withoutTenant clears an enclosing tenant for cross-tenant maintenance
      Given no tenant is provided
      When the ambient tenant is read inside "withTenant" for "tenant-a" and then inside "withoutTenant"
      Then the ambient tenant read inside is none

    @REQ-EA-817
    Scenario: A composition that never provides a tenant behaves as one written before tenancy existed
      Given no tenant is provided
      When a user "solo@example.com" is created
      And a session is issued for that user
      Then that user has no tenant
      And the session view has no tenant

    @REQ-EA-818
    Scenario: The tenant is an opaque string that core never resolves to an organization
      Given no organization exists
      When a user "opaque@example.com" is created under the tenant "not-an-organization"
      Then that user's tenant is "not-an-organization"

  # BEH-EA-231 — spec/behaviors/28-tenancy.md; see also ADR-EA-018
  @BEH-EA-231
  Rule: Every core insert is stamped with the ambient tenant

    @REQ-EA-819
    Scenario Outline: An insert under an ambient tenant stores that tenant on the row
      Given the ambient tenant is "tenant-a"
      When one row is inserted into "<table>"
      Then the stored "tenantId" of that row is "tenant-a"

      Examples:
        | table                     |
        | users                     |
        | accounts                  |
        | sessions                  |
        | verification_tokens       |
        | verification_reservations |
        | auth_audit_log            |

    @REQ-EA-820
    Scenario Outline: An insert with no ambient tenant stores NULL
      Given no tenant is provided
      When one row is inserted into "<table>"
      Then the stored "tenantId" of that row is NULL

      Examples:
        | table                     |
        | users                     |
        | accounts                  |
        | sessions                  |
        | verification_tokens       |
        | verification_reservations |
        | auth_audit_log            |

    @REQ-EA-821
    Scenario: An explicit tenant on the input wins over the ambient one
      Given the ambient tenant is "tenant-a"
      When a user "explicit@example.com" is inserted with the explicit tenant "tenant-explicit"
      Then that user's tenant is "tenant-explicit"

    @REQ-EA-822
    Scenario: A row is stamped once and a later update does not move it
      Given the ambient tenant is "tenant-a"
      And a user "stamped@example.com" is created
      When that user's profile is updated under the tenant "tenant-b"
      Then that user's tenant is "tenant-a"

    @REQ-EA-823
    Scenario: A request body cannot name a tenant
      When a create payload for "users" naming the tenant "tenant-x" is decoded
      Then the decoded payload carries no "tenantId"
      And the "users" update variant has no "tenantId" field

    @REQ-EA-824
    Scenario: The user record and the session view expose the tenant they were stamped with
      Given the ambient tenant is "tenant-a"
      And a user "exposed@example.com" is created
      When a session is issued for that user
      Then that user's tenant is "tenant-a"
      And the session view's tenant is "tenant-a"

  # BEH-EA-232 — spec/behaviors/28-tenancy.md; see also ADR-EA-018
  @BEH-EA-232
  Rule: The identity directory is global across tenants

    @REQ-EA-825
    Scenario: A user created under one tenant is found by email from another tenant's request
      Given a user "shared@example.com" is created under the tenant "tenant-a"
      When "shared@example.com" is looked up by email under the tenant "tenant-b"
      Then the lookup finds that user

    @REQ-EA-826
    Scenario: An account created under one tenant is found by provider subject from another tenant's request
      Given a user "linked@example.com" is created under the tenant "tenant-a"
      And that user is linked to the provider "github" with the subject "subject-1" under the tenant "tenant-a"
      When the provider "github" subject "subject-1" is looked up under the tenant "tenant-b"
      Then the lookup finds that account

    @REQ-EA-827
    Scenario: The same email cannot be registered again under another tenant
      Given a user "unique@example.com" is created under the tenant "tenant-a"
      When a user "Unique@Example.com" is registered under the tenant "tenant-b"
      Then the registration is refused because the email already exists

    @REQ-EA-828
    Scenario: The same provider subject cannot be linked again under another tenant
      Given a user "first@example.com" is created under the tenant "tenant-a"
      And a user "second@example.com" is created under the tenant "tenant-b"
      And the first user is linked to the provider "github" with the subject "subject-2" under the tenant "tenant-a"
      When the second user is linked to the provider "github" with the subject "subject-2" under the tenant "tenant-b"
      Then the link is refused because the account is already linked

    @REQ-EA-829
    Scenario: Tenant routing applies to sessions, which keep the tenant they were issued under
      Given a user "routed@example.com" is created under the tenant "tenant-a"
      And a session is issued for that user under the tenant "tenant-a"
      When that session is verified under the tenant "tenant-b"
      Then the session view's tenant is "tenant-a"

  # BEH-EA-233 — spec/behaviors/28-tenancy.md; see also ADR-EA-009
  @BEH-EA-233
  Rule: Postgres row-level security is an opt-in, fail-closed backstop inside a tenant scope

    @REQ-EA-830
    Scenario: Enabling row-level security is idempotent and a no-op off Postgres
      Given a user "rls@example.com" is created under the tenant "tenant-a"
      When row-level security is enabled twice
      Then no error is raised
      And "rls@example.com" is still found by email

    @REQ-EA-831
    Scenario: Outside Postgres a tenant scope still provides the ambient tenant that stamps inserts
      When a user "scoped@example.com" is created inside a "TenantScope" for "tenant-a"
      Then that user's tenant is "tenant-a"

    # @skip: needs a real Postgres session (row-level security does not exist on SQLite); covered by the pg suite `pnpm run test:pg` — packages/sql/test/Repositories.postgres.test.ts, "Tenant RLS (real Postgres)"
    @skip
    @REQ-EA-832
    Scenario: Inside a tenant scope a read cannot see another tenant's row
      Given row-level security is enabled on Postgres
      And a session row stamped "tenant-a" and a session row stamped "tenant-b"
      When the sessions are read inside a tenant scope for "tenant-a"
      Then only the "tenant-a" row is visible

    # @skip: needs a real Postgres session; covered by the pg suite `pnpm run test:pg` — packages/sql/test/Repositories.postgres.test.ts, "Tenant RLS (real Postgres)"
    @skip
    @REQ-EA-833
    Scenario: Inside a tenant scope a write can neither touch nor create another tenant's row
      Given row-level security is enabled on Postgres
      When a write naming the tenant "tenant-b" runs inside a tenant scope for "tenant-a"
      Then the write is refused and no "tenant-b" row exists

    # @skip: needs a real Postgres session; covered by the pg suite `pnpm run test:pg` — packages/sql/test/Repositories.postgres.test.ts, "Tenant RLS (real Postgres)"
    @skip
    @REQ-EA-834
    Scenario: With no tenant set the policy admits every row
      Given row-level security is enabled on Postgres
      When the sessions are read with no tenant set
      Then every row is visible

  # BEH-EA-234 — spec/behaviors/28-tenancy.md; see also ADR-EA-010
  @BEH-EA-234
  Rule: The tenant middleware resolves the organization once per request

    @REQ-EA-835
    Scenario: A request whose resolver names an existing organization runs under that tenant
      Given the organization "acme" exists
      And the tenant middleware is installed
      When a request naming the organization "acme" is served
      Then the handler saw the tenant "acme"

    @REQ-EA-836
    Scenario: The resolver is called once per request
      Given the organization "acme" exists
      And the tenant middleware is installed
      When a request naming the organization "acme" is served
      Then the resolver was called 1 time

    @REQ-EA-837
    Scenario: A request the resolver leaves untenanted runs with no tenant
      Given the tenant middleware is installed
      When a request naming no organization is served
      Then the response status is 200
      And the handler saw no tenant

    @REQ-EA-838
    Scenario: A resolver id naming no organization is refused rather than run untenanted
      Given the tenant middleware is installed
      When a request naming the organization id "no-such-org" is served
      Then the response status is 404
      And the response body names "OrganizationNotFound"
      And the handler never ran

    @REQ-EA-839
    Scenario: An application that never installs the middleware sees no tenant
      Given the organization "acme" exists
      And no tenant middleware is installed
      When a request naming the organization "acme" is served
      Then the handler saw no tenant

    @REQ-EA-840
    Scenario: A suspended organization still resolves so its own gate can refuse it
      Given the organization "acme" exists
      And the organization "acme" is suspended
      And the tenant middleware is installed
      When a request naming the organization "acme" is served
      Then the handler saw the tenant "acme"

    @REQ-EA-841
    Scenario: The row-level-security variant provides the same ambient tenant
      Given the organization "acme" exists
      And the tenant middleware with row-level security is installed
      When a request naming the organization "acme" is served
      Then the handler saw the tenant "acme"

  # BEH-EA-235 — spec/behaviors/28-tenancy.md; see also ADR-EA-018
  @BEH-EA-235
  Rule: Organization OAuth connections are consulted after the static registry

    @REQ-EA-842
    Scenario: A connection's provider id is namespaced by organization and connection
      Given the organization "acme" has stored an OAuth2 connection
      Then the connection's provider id is namespaced by the organization and the connection

    @REQ-EA-843
    Scenario: A connection id that is not in the static registry resolves through the installed connection resolver
      Given the organization "acme" has stored an OAuth2 connection
      And OAuth is composed with the stored connections and no static provider
      When the connection's provider is authorized
      Then the redirect names the connection's own callback path

    @REQ-EA-844
    Scenario: A static provider id is resolved without consulting the connection resolver
      Given OAuth is composed with a static provider "acme" and a counting connection resolver
      When the provider "acme" is authorized
      Then the redirect names the client id of the static provider
      And the connection resolver was never consulted

    @REQ-EA-845
    Scenario: Another organization's connection id and an unknown id are provider-not-found
      Given the organization "acme" has stored an OAuth2 connection
      And OAuth is composed with the stored connections and no static provider
      When another organization's id for the connection is authorized
      Then the outcome is "ProviderNotFound"
      When an unknown connection id of the organization "acme" is authorized
      Then the outcome is "ProviderNotFound"

    @REQ-EA-846
    Scenario: With no connection resolver installed a connection id is unknown
      Given the organization "acme" has stored an OAuth2 connection
      And OAuth is composed with a static provider "acme" and no connection resolver
      When the connection's provider is authorized
      Then the outcome is "ProviderNotFound"

    @REQ-EA-847
    Scenario: A connection's client secret is ciphertext at rest and never shown back
      Given the organization "acme" has stored an OAuth2 connection with the client secret "super-secret"
      Then the stored secret is an encryption envelope that does not contain "super-secret"
      And the connection view carries no client secret

  # BEH-EA-236 — spec/behaviors/28-tenancy.md; see also ADR-EA-005
  @BEH-EA-236
  Rule: Per-tenant configuration applies per request without changing the plugin tuple

    @REQ-EA-848
    Scenario: Two tenants with different configuration are served by one composition
      Given the organization "small" exists with a membership limit of 1
      And the organization "big" exists with a membership limit of 50
      And the tenant middleware with per-tenant configuration is installed
      When a request naming the organization "small" reads the limit in force
      Then the limit in force is 1 and the configuration is applied for "small"
      When a request naming the organization "big" reads the limit in force
      Then the limit in force is 50 and the configuration is applied for "big"

    @REQ-EA-849
    Scenario: With no tenant provided the build-time value applies exactly as before
      Given the tenant middleware with per-tenant configuration is installed
      When a request naming no organization reads the limit in force
      Then the limit in force is 100, the configuration reference's default, and no configuration is applied for any tenant

    @REQ-EA-850
    Scenario: The Organization plugin decides its configuration per operation
      Given a signed-in user "alice" who owns the organization "small" and the organization "big"
      And the tenant "small" configures a membership limit of 1 and the tenant "big" one of 2
      When one member is added to "small" and two members are added to "big", each under its own tenant's configuration
      Then the addition to "small" is refused with "MembershipLimitReached"
      And the first addition to "big" succeeds and the second is refused with "MembershipLimitReached"

    @REQ-EA-851
    Scenario: With no per-request configuration the build-time value applies
      Given a signed-in user "alice" who owns the organization "acme"
      When three members are added in turn with no per-request configuration
      Then the first two additions succeed and the third is refused with "MembershipLimitReached"

  # BEH-EA-237 — spec/behaviors/28-tenancy.md; see also ADR-EA-018
  @BEH-EA-237
  Rule: A suspended organization refuses organization-scoped access

    @REQ-EA-852
    Scenario: A suspended organization refuses its own members
      Given a signed-in user "alice" who owns the organization "acme"
      And a platform administrator "superadmin"
      When "superadmin" suspends the organization "acme"
      Then "alice" reading the organization "acme" is refused with "OrganizationNotFound"
      And "alice" updating the organization "acme" is refused with "OrganizationNotFound"

    @REQ-EA-853
    Scenario: A suspended organization answers an outsider exactly as it answers an unknown id
      Given a signed-in user "alice" who owns the organization "acme"
      And a signed-in user "mallory" who owns no organization
      And a platform administrator "superadmin"
      When "superadmin" suspends the organization "acme"
      Then "mallory" reading the organization "acme" is refused with "OrganizationNotFound"
      And "mallory" reading an organization that does not exist is refused with "OrganizationNotFound"

    @REQ-EA-854
    Scenario: A member's own list still returns a suspended organization, flagged
      Given a signed-in user "alice" who owns the organization "acme"
      And a platform administrator "superadmin"
      When "superadmin" suspends the organization "acme"
      Then "alice" lists exactly the organization "acme" flagged as suspended

    @REQ-EA-855
    Scenario: A suspended organization can neither become nor remain a member's active organization
      Given a signed-in user "alice" who owns the organization "acme"
      And "alice" has made the organization "acme" her active organization
      And a platform administrator "superadmin"
      When "superadmin" suspends the organization "acme"
      Then "alice" has no active member
      And "alice" making the organization "acme" her active organization is refused with "MembershipNotFound"

    @REQ-EA-856
    Scenario: Reinstating an organization restores access exactly as it was
      Given a signed-in user "alice" who owns the organization "acme"
      And a platform administrator "superadmin"
      And "superadmin" has suspended the organization "acme"
      When "superadmin" reinstates the organization "acme"
      Then "alice" can read the organization "acme"

    @REQ-EA-857
    Scenario: Suspension is idempotent and keeps the original time
      Given a signed-in user "alice" who owns the organization "acme"
      And a platform administrator "superadmin"
      When "superadmin" suspends the organization "acme" twice
      Then the second suspension reports the first suspension's time

    @REQ-EA-858
    Scenario: Suspension is published as an audited event naming the administrator
      Given a signed-in user "alice" who owns the organization "acme"
      And a platform administrator "superadmin"
      When "superadmin" suspends the organization "acme"
      And "superadmin" reinstates the organization "acme"
      Then the audit log holds one "auth.admin.organizationSuspended" event by "superadmin"
      And the audit log holds one "auth.admin.organizationUnsuspended" event by "superadmin"

    @REQ-EA-859
    Scenario: A caller who may not administer tenants is refused before existence is checked
      Given a signed-in user "alice" who owns the organization "acme"
      And a signed-in user "mallory" who owns no organization
      When "mallory" tries to suspend the organization "acme"
      And "mallory" tries to suspend an organization that does not exist
      Then both attempts are refused with "AdminActionDenied"
      And "alice" can read the organization "acme"

    @REQ-EA-860
    Scenario: A suspended organization confers no qadi relationship through its memberships
      Given a signed-in user "alice" who owns the organization "acme"
      And a platform administrator "superadmin"
      And qadi finds "alice" related to the organization "acme" as "member"
      When "superadmin" suspends the organization "acme"
      Then qadi finds "alice" unrelated to the organization "acme" as "member"
      And qadi finds "alice" unrelated to the organization "acme" as "owner"
