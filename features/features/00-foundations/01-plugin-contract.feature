# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@foundations @plugin-contract
Feature: Plugin Contract

  # BEH-EA-001 — spec/behaviors/01-plugin-contract.md; see also
  # ADR-EA-008, ADR-EA-001.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-001 @compile-time
  Rule: A plugin is a Context.Service class produced by AuthPlugin.Service

    @REQ-EA-001
    Scenario: A plugin built with AuthPlugin.Service is usable as an ordinary Effect service
      Given a plugin class "Password" produced by "AuthPlugin.Service<Self, Shape>()(id, options)"
      When application code depends on "Password" the same way it depends on any other Effect service
      Then "Password" can be required with "yield* Password"
      And "Password" can be supplied with "Layer.provide"

    @REQ-EA-002
    Scenario: A plugin requires no second, plugin-specific runtime for resolution or lifecycle
      Given a plugin class "Password" produced by "AuthPlugin.Service"
      When "Password" is composed into an application
      Then its resolution and lifecycle are handled entirely by the ordinary Effect "Layer" runtime
      And no bespoke plugin resolver or lifecycle manager is involved

  # BEH-EA-002 — spec/behaviors/01-plugin-contract.md
  @BEH-EA-002 @compile-time
  Rule: A plugin's id is a literal, namespaced string that keys its service instance

    @REQ-EA-003
    Scenario: A plugin's compiled service key embeds its own id
      Given a plugin class "Password" declared with id "password"
      When "Password"'s compiled service key is inspected
      Then the key is "awthaq/plugin/password"

    @REQ-EA-004
    Scenario: A missing-dependency diagnostic names the plugin by id rather than an opaque unsatisfied requirement
      Given a plugin "TwoFactor" that depends on a plugin whose service key is "awthaq/plugin/password"
      When "TwoFactor"'s dependency is reported as unsatisfied
      Then the diagnostic names the plugin "password" by id
      And the diagnostic does not merely report an opaque unsatisfied requirement

  # BEH-EA-003 — spec/behaviors/01-plugin-contract.md
  @BEH-EA-003 @compile-time
  Rule: apiVersion 1 is a literal generation gate, checked pairwise at Auth.make

    @REQ-EA-005
    Scenario: A plugin built against the accepted Plugin API generation composes normally
      Given a plugin declaring "apiVersion: 1"
      And "Auth.make" accepts Plugin API generation 1
      When the plugin is passed as an argument to "Auth.make"
      Then the plugin type-checks as an argument to "Auth.make"

    @REQ-EA-006
    Scenario: A plugin built against a different Plugin API generation fails to type-check, naming the plugin
      Given a plugin declaring an "apiVersion" other than the generation "Auth.make" accepts
      When the plugin is passed as an argument to "Auth.make"
      Then the plugin fails to type-check as an argument to "Auth.make"
      And the failure names the offending plugin
      And the failure occurs before any other validation runs

  # BEH-EA-004 — spec/behaviors/01-plugin-contract.md; see also INV-EA-006.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-004 @compile-time
  Rule: A plugin's contract groups are constrained to its own namespace by a template-literal type

    @REQ-EA-007
    Scenario: A contract group named after the plugin's own id type-checks
      Given a plugin with id "acme.invite"
      When its contract declares an "HttpApiGroup" with id "acme.invite"
      Then the plugin's class definition type-checks

    @REQ-EA-008
    Scenario: A contract group named as a dotted sub-id of the plugin's own id type-checks
      Given a plugin with id "acme.invite"
      When its contract declares an "HttpApiGroup" with id "acme.invite.admin"
      Then the plugin's class definition type-checks

    @REQ-EA-009
    Scenario: A contract group named outside the plugin's own namespace fails to type-check at the plugin's own definition
      Given a plugin with id "acme.invite"
      When its contract declares an "HttpApiGroup" with id "invitations"
      Then the plugin's class definition fails to type-check
      And the failure occurs at the plugin's own definition site, not at "Auth.make"

  # BEH-EA-005 — spec/behaviors/01-plugin-contract.md
  @BEH-EA-005 @compile-time
  Rule: A plugin's table names are constrained to its own prefix by a template-literal type

    @REQ-EA-010
    Scenario: A table name prefixed with the plugin's own id type-checks
      Given a plugin with id "password"
      When its "tables" array declares the entry "password_account"
      Then the plugin's class definition type-checks

    @REQ-EA-011
    Scenario: A bare table name fails to type-check as an argument to AuthPlugin.Service
      Given a plugin with id "password"
      When its "tables" array declares the bare entry "account"
      Then the declaration fails to type-check as an argument to "AuthPlugin.Service"

    @REQ-EA-984
    Scenario: A table name under another plugin's prefix fails to type-check
      Given a plugin with id "password"
      When its "tables" array declares the entry "oauth_account" under another plugin's prefix
      Then the declaration fails to type-check as an argument to "AuthPlugin.Service"

  # BEH-EA-006 — spec/behaviors/01-plugin-contract.md
  @BEH-EA-006 @compile-time
  Rule: migrations is a static, declarative member, never computed from runtime configuration

    @REQ-EA-012
    Scenario: A plugin's migrations are resolvable from its static class members with no Layer evaluated
      Given a plugin class "Password" declaring a static "migrations" member
      When the CLI reads "Password"'s manifest ("awthaq plugin list --graph", "schema")
      Then "migrations" is resolved by reading "Password"'s static class members alone
      And no "Layer" is evaluated and no configuration service is provided to resolve it

    @REQ-EA-013
    Scenario: A plugin's migrations are the same value across every runtime configuration
      Given a plugin class "Password" declaring a static "migrations" member
      When "Password" is configured with two different runtime configurations
      Then the resolved "migrations" value is identical under both configurations

  # BEH-EA-007 — spec/behaviors/01-plugin-contract.md
  @BEH-EA-007 @compile-time
  Rule: All static members are frozen for the lifetime of a plugin's options — options reach only Layers

    @REQ-EA-014
    Scenario: A configuration Layer alters only what make-time produces
      Given a plugin "Password" with a configuration Layer "Password.config(partial)"
      When "Password.config({ minLength: 16 })" is provided
      Then only the value "Password"'s "Layer" produces at make-time changes

    @REQ-EA-015
    Scenario: A configuration Layer cannot change a plugin's static id, apiVersion, contract, or tables
      Given a plugin "Password" with static "id", "apiVersion", "contract", and "tables" members
      When any value is passed to "Password.config(...)"
      Then "Password"'s "id", "apiVersion", "contract", and "tables" remain unchanged

  # BEH-EA-008 — spec/behaviors/01-plugin-contract.md
  @BEH-EA-008 @compile-time
  Rule: dependsOn declares both ordering and a typed requirement in one static array

    @REQ-EA-016
    Scenario: Every class listed in dependsOn joins the plugin's Layer RIn
      Given a plugin "Password" declaring "dependsOn: [Sessions, Users]" on its "layer"
      When "Password"'s "layer" type is inspected
      Then "Sessions" and "Users" both appear in the "layer"'s "RIn"

    @REQ-EA-017
    Scenario: A dependsOn entry is simultaneously a migration-ordering fact and a compile-time requirement
      Given a plugin "Password" declaring "dependsOn: [Sessions, Users]"
      When the linker computes migration order and a consumer composes "Password"'s "layer"
      Then the linker orders "Password"'s migrations after "Sessions" and "Users"
      And any consumer of "Password"'s "layer" must satisfy "Sessions" and "Users" as a compile-time requirement
