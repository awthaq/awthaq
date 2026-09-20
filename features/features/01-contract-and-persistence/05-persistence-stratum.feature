# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@foundations @persistence
@skip @unwired
Feature: The Persistence Stratum

  # BEH-EA-033 — spec/behaviors/05-persistence-stratum.md; see also ADR-EA-004
  @BEH-EA-033
  Rule: Every entity is a Model.Class with Model.UuidV7Insert ids

    @REQ-EA-084
    Scenario Outline: Each core entity is declared as a Model.Class
      Given the "<entity>" entity definition
      When the definition is inspected
      Then "<entity>" is declared as a Model.Class

      Examples:
        | entity            |
        | User               |
        | Account            |
        | Session            |
        | VerificationToken  |

    @REQ-EA-085
    Scenario: An entity's id is assigned by the supplier as a UuidV7Insert value
      Given a new "User" is created through the ordinary creation path
      When the row is inserted
      Then the "id" column is assigned a Model.UuidV7Insert value by the supplier

    @REQ-EA-086
    Scenario: The ordinary creation path never accepts a client-supplied id
      Given a creation request for a "User" that includes an "id" field chosen by the caller
      When the entity is created through the ordinary creation path
      Then the caller-supplied "id" is not the id assigned to the created row

  # BEH-EA-034 — spec/behaviors/05-persistence-stratum.md
  @BEH-EA-034
  Rule: Model.Sensitive fields never appear in any JSON variant of an entity

    @REQ-EA-087
    Scenario: A Model.Sensitive field is excluded from an entity's JSON-encoding variant
      Given an "Account" entity whose "passwordHash" field is declared Model.Sensitive
      When the entity is encoded to its JSON variant
      Then the "passwordHash" field does not appear in the encoded JSON

    @REQ-EA-088
    Scenario: Returning the entity value directly does not leak its sensitive fields
      Given a handler that returns an "Account" entity value directly as its response
      When the response is serialized
      Then the "passwordHash" and "accessToken" fields are absent from the HTTP response

    @REQ-EA-089
    Scenario: A Redacted Model.Sensitive field never reaches logs, spans, or events
      Given an "Account" entity whose "accessToken" field is declared Model.Sensitive(Schema.Redacted(Schema.String))
      When the entity passes through logging, tracing spans, and emitted events
      Then no Redacted value for "accessToken" reaches any log, span, or event

  # BEH-EA-035 — spec/behaviors/05-persistence-stratum.md
  @BEH-EA-035
  Rule: Repositories are built with SqlModel.makeRepository over the ambient SqlClient, never opening their own transactions

    @REQ-EA-090
    Scenario: A repository is constructed as a Context.Service via SqlModel.makeRepository
      Given a "Users" repository built with SqlModel.makeRepository against the ambient SqlClient
      When the repository is resolved
      Then it is provided as a Context.Service

    @REQ-EA-091
    Scenario: A repository method does not open its own transaction
      Given a repository method that reads or writes a "User" row
      When the method executes
      Then it does not call SqlClient.withTransaction itself

    @REQ-EA-092
    Scenario: A domain service composing two repository calls holds the transaction boundary
      Given "Password.confirmReset" consuming a verification token and rotating a session in one operation
      When "Password.confirmReset" runs
      Then the domain service itself opens the transaction boundary around both repository calls
      And the token consumption and the session rotation commit or roll back together

  # BEH-EA-036 — spec/behaviors/05-persistence-stratum.md
  @BEH-EA-036
  Rule: Pagination is keyset-only; no repository interface accepts an offset

    @REQ-EA-093
    Scenario: A paginated query accepts an opaque cursor instead of an offset
      Given a "listByUser" query for a user's sessions
      When the query is called with a cursor derived from a prior page's last (createdAt, id)
      Then the query accepts the cursor
      And the query's interface has no offset parameter

    @REQ-EA-094
    Scenario: A paginated query returns the next cursor alongside its page
      Given a "listByUser" query for a user's sessions with more rows beyond the requested limit
      When the query is called
      Then the returned page is accompanied by a next cursor derived from the page's last (createdAt, id)

    @REQ-EA-095
    Scenario: Rows sharing the same createdAt millisecond are still ordered deterministically
      Given two session rows with an identical createdAt timestamp down to the millisecond
      When a paginated query orders by (createdAt, id)
      Then the "id" tiebreaker produces one deterministic order between the two rows

  # BEH-EA-037 — spec/behaviors/05-persistence-stratum.md
  @BEH-EA-037
  Rule: A plugin's migrations are v4 Migrator records, exported statically per plugin

    @REQ-EA-096
    Scenario: A plugin's migrations resolve without evaluating its make Layer
      Given a plugin exposing a static "migrations" member
      When the plugin's migrations are read
      Then they resolve without evaluating the plugin's "make" Layer

    @REQ-EA-097
    Scenario: A plugin's migrations resolve without providing any configuration
      Given a plugin exposing a static "migrations" member
      When the plugin's migrations are read with no configuration provided
      Then the migrations resolve successfully

    @REQ-EA-098
    Scenario: A plugin's migrations are Migrator records keyed by name
      Given a plugin exposing a static "migrations" member
      When the migrations are inspected
      Then each migration is an @effect/sql Migrator record keyed by its name

  # BEH-EA-038 — spec/behaviors/05-persistence-stratum.md
  @BEH-EA-038
  Rule: The linker orders and re-keys every plugin's migrations into one deterministic sequence

    @REQ-EA-099
    Scenario: Core's migrations run before any plugin's migrations
      Given an installed plugin set including "password" and "oauth"
      When the linker composes the migration sequence
      Then core's migrations appear first in the sequence

    @REQ-EA-100
    Scenario: Plugin migrations are ordered by dependsOn and re-keyed
      Given an installed plugin set including "password" (depending on "core") and "oauth" (depending on "core")
      When the linker composes the migration sequence
      Then each plugin's migrations follow their dependsOn topological order
      And each migration is re-keyed "NNNN_<plugin>_<name>"

    @REQ-EA-101
    Scenario: The same installed plugin set always produces the same sequence
      Given an installed plugin set including "password" and "oauth"
      When the linker composes the migration sequence twice, independently
      Then both compositions produce the identical ordered, re-keyed sequence

    @REQ-EA-102
    Scenario: A table with a foreign key into another plugin's table migrates after its target exists
      Given a plugin "oauth_account" whose table has a foreign key into a table owned by "password", and "oauth" declares "password" in dependsOn
      When the linker composes the migration sequence
      Then "password"'s migration creating its table runs before "oauth"'s migration that references it

  # BEH-EA-039 — spec/behaviors/05-persistence-stratum.md
  @BEH-EA-039
  Rule: Schema diffing, snapshot comparison, and destructive-change guardrails are a deferred CLI feature, not a v1 runtime requirement

    @REQ-EA-103
    Scenario: Auth.make functions without a snapshot-diff planner, checksum ledger, or drift check
      Given an application composing "Auth.make", "auth.layer", and "auth.migrations"
      When the application boots
      Then it does not depend on a snapshot-diff planner, a checksum ledger, or a live-database drift check

    @REQ-EA-104
    Scenario: A future CLI schema-diff feature consumes the runtime's existing auth.migrations value
      Given a CLI schema-diff feature that will need the composed migration set
      When the CLI feature is built
      Then it consumes the same "auth.migrations" value the runtime already produces
      And it does not require a separate migration representation from the runtime

  # BEH-EA-040 — spec/behaviors/05-persistence-stratum.md; see also
  # INV-EA-016
  @BEH-EA-040
  Rule: A plugin migration may only alter tables under its own prefix; shared tables are altered only through a declared extension point

    @REQ-EA-105
    Scenario: A plugin's migration creates or alters only tables under its own prefix
      Given a plugin "password" whose migrations create the table "password_account"
      When the plugin's migrations run
      Then the plugin creates or alters only tables named "password_<table>"

    @REQ-EA-106
    Scenario: A plugin's migration that directly alters a core-owned shared table is rejected
      Given a plugin migration that attempts to ALTER TABLE "users" directly
      When the plugin's migrations are validated
      Then the migration is rejected
      And the shared table "users" is not altered

    @REQ-EA-107
    Scenario: A plugin extends a shared table only through a declared extension point
      Given a plugin that needs to attach derived data to a signed-in user's session
      When the plugin contributes that data through a declared extension point, such as a hook point or the SessionClaims registry
      Then the shared table's own schema is not modified by the plugin's migration
      And the extension is visible only through the declared extension point

    @REQ-EA-108
    Scenario: A shared-table extension is limited to a primitive, nullable or defaulted scalar
      Given a declared extension point for the shared "users" table
      When a plugin contributes an extension through that point
      Then the extension is a primitive, nullable or defaulted scalar value
      And it is never an unmediated ALTER TABLE from the plugin's migration code
