# effect-auth is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@tooling @cli
Feature: CLI

  # BEH-EA-201 — spec/behaviors/26-cli.md
  @BEH-EA-201
  Rule: doctor checks link, config, and insecure defaults

    @REQ-EA-573
    Scenario: doctor reports every plugin-graph linking problem
      Given an installed plugin set with a missing declared dependency
      When "effect-auth doctor" runs
      Then it reports the plugin-graph linking problem

    @REQ-EA-574
    Scenario: doctor reports every configuration value it can validate
      Given an application configuration containing a value doctor can validate
      When "effect-auth doctor" runs
      Then it reports the result of validating that configuration value

    @REQ-EA-575
    Scenario Outline: doctor reports each known insecure-default combination
      Given an application configured with <insecure default>
      When "effect-auth doctor" runs
      Then it reports <insecure default> as an insecure default

      Examples:
        | insecure default                                          |
        | "sameSite" relaxed to "lax"                                |
        | CSRF protection disabled                                  |
        | a development mailer configured in a production environment |

    @REQ-EA-576
    Scenario: doctor produces its report without the application running
      Given an application that is not started, with no live process and no listening server
      When "effect-auth doctor" runs
      Then it produces its full report
      And no running application instance is required

  # BEH-EA-202 — spec/behaviors/26-cli.md
  @BEH-EA-202
  Rule: plugin list --graph shows topology, ports, and hook chains

    @REQ-EA-577
    Scenario: plugin list --graph prints installed plugins in topological dependency order
      Given an installed plugin set including "password" and "oauth", where "oauth" depends on "password"
      When "effect-auth plugin list --graph" runs
      Then "password" is printed before "oauth"

    @REQ-EA-578
    Scenario: plugin list --graph prints each plugin's required ports
      Given an installed plugin set including "oauth", which requires the "TokenStore" port
      When "effect-auth plugin list --graph" runs
      Then "oauth"'s row lists "TokenStore" among its required ports

    @REQ-EA-579
    Scenario: plugin list --graph prints each plugin's resolved hook-tap chain
      Given an installed plugin set with taps registered on the "AfterSignUp" hook point
      When "effect-auth plugin list --graph" runs
      Then the printed output includes the resolved tap chain for "AfterSignUp"

    @REQ-EA-580
    Scenario: The printed ordering matches the order the linker uses for migrations and hook resolution
      Given an installed plugin set composed by "Auth.make"
      When "effect-auth plugin list --graph" prints the plugin order
      Then that printed order is identical to the order the linker uses to sequence migrations and resolve hook taps

  # BEH-EA-203 — spec/behaviors/26-cli.md
  @BEH-EA-203
  Rule: routes lists every endpoint with its owning plugin and middleware

    @REQ-EA-581
    Scenario: routes lists an endpoint with its method, path, group, plugin, and middleware chain
      Given a composed "AuthApi" contract with an endpoint "POST /password/sign-in" owned by group "password" and plugin "Password", protected by "RateLimiter" middleware
      When "effect-auth routes" runs
      Then the listing includes a row for "POST /password/sign-in" carrying its method, path, owning group "password", owning plugin "Password", and its "RateLimiter" middleware

    @REQ-EA-582
    Scenario: routes omits no endpoint present in the compiled contract
      Given a composed "AuthApi" contract with a known number of endpoints across every installed plugin
      When "effect-auth routes" runs
      Then the listing contains exactly one row per endpoint in the contract, with none omitted

    @REQ-EA-583
    Scenario: routes reads the compiled contract without making a request or running a handler
      Given a composed "AuthApi" contract
      When "effect-auth routes" runs
      Then it produces its listing without making any HTTP request or running any handler

  # BEH-EA-204 — spec/behaviors/26-cli.md
  @BEH-EA-204
  Rule: migration status and apply read and advance the ledger

    @REQ-EA-584
    Scenario: migration status reports applied and pending migrations against the ledger
      Given the linker's ordered, re-keyed migration record for the installed plugin set
      And the driver's "Migrator" ledger showing some of those migrations already applied
      When "effect-auth migration status" runs
      Then it reports each migration as applied or pending by comparing the linker's record against the ledger

    @REQ-EA-585
    Scenario: migration apply refuses to run without an explicit confirmation flag
      Given pending migrations reported by "effect-auth migration status"
      When "effect-auth migration apply" is run without the "--yes" flag
      Then it refuses to apply any migration

    @REQ-EA-586
    Scenario: migration apply proceeds once the explicit --yes flag is given
      Given pending migrations reported by "effect-auth migration status"
      When "effect-auth migration apply --yes" runs
      Then the pending migrations are applied

    @REQ-EA-587
    Scenario: migration apply applies migrations in the linker's fixed order
      Given an installed plugin set whose migrations are ordered core first, then topologically, keyed "NNNN_<plugin>_<name>"
      When "effect-auth migration apply --yes" runs
      Then the migrations are applied in that exact fixed order

  # BEH-EA-205 — spec/behaviors/26-cli.md
  @BEH-EA-205
  Rule: openapi exports the aggregated document

    @REQ-EA-588
    Scenario: openapi emits one document covering core and every installed plugin's contract
      Given an installed plugin set including "password" and "oauth"
      When "effect-auth openapi" runs
      Then it emits one OpenAPI document whose paths cover core's contract and both "password"'s and "oauth"'s contracts

    @REQ-EA-589
    Scenario: A non-Effect consumer never assembles multiple per-plugin documents themselves
      Given a consumer that does not import "effect" and wants to generate an HTTP client
      When that consumer uses the output of "effect-auth openapi"
      Then it receives the single aggregated document
      And it is never required to assemble or merge multiple per-plugin OpenAPI documents itself

    @REQ-EA-590
    Scenario: The aggregated document is generated from the same merged AuthApi the Effect client is generated from
      Given the composed "AuthApi" contract used to generate the Effect-based client
      When "effect-auth openapi" runs
      Then the emitted document is generated from that same merged contract

  # BEH-EA-206 — spec/behaviors/26-cli.md
  @BEH-EA-206
  Rule: seed admin provisions the first privileged account

    @REQ-EA-591
    Scenario: seed admin creates or promotes an account to admin through the Users and Roles domain services
      Given no administrative account exists yet
      When "effect-auth seed admin" runs for account "ops@acme.com"
      Then the account is created or promoted to an administrative role through the "Users" and "Roles" domain services

    @REQ-EA-592
    Scenario: seed admin never writes rows directly to the database
      Given "effect-auth seed admin" provisioning an account
      When it runs
      Then it does not write rows to the database directly, bypassing "Users" or "Roles"

    @REQ-EA-593
    Scenario: seed admin refuses to run when an administrative account already exists
      Given an administrative account already exists
      When "effect-auth seed admin" runs without a force flag
      Then it refuses to create or promote another administrative account

    @REQ-EA-594
    Scenario: seed admin proceeds against an existing administrative account only when explicitly forced
      Given an administrative account already exists
      When "effect-auth seed admin --force" runs
      Then it proceeds to create or promote the requested account

    @REQ-EA-595
    Scenario: seed admin has no admin concept to grant without the Roles plugin installed
      Given an installed plugin set that does not include "Roles"
      When "effect-auth seed admin" runs
      Then there is no administrative role concept for it to grant

  # BEH-EA-207 — spec/behaviors/26-cli.md
  @BEH-EA-207
  Rule: import migrates users from a named source framework

    @REQ-EA-596
    Scenario Outline: import supports each named source framework
      Given a user/account/session export from "<framework>"
      When "effect-auth import --from <framework>" runs
      Then the export's tables are translated into effect-auth's own Model.Class shapes

      Examples:
        | framework   |
        | better-auth |
        | authjs      |
        | lucia       |

    @REQ-EA-597
    Scenario: A source field with no effect-auth equivalent is reported rather than silently dropped
      Given a source export containing a field effect-auth's Model.Class shapes have no equivalent for
      When "effect-auth import" translates that export
      Then the unmapped field is reported to the operator
      And the field is not silently dropped

    @REQ-EA-598
    Scenario: effect-auth import is planned CLI tooling the runtime does not depend on
      Given an application composing "Auth.make", "auth.layer", and "auth.migrations"
      When the application boots
      Then it does not depend on "effect-auth import" existing

    @REQ-EA-599
    Scenario: import's source-framework mappings are not assumed correct without validation against real exports
      Given "effect-auth import"'s mapping for "better-auth", "authjs", or "lucia"
      When that mapping is relied on for a production user-base migration
      Then it is expected to have been built and validated against a real export from that source first
      And it is not assumed correct from this specification alone

  # BEH-EA-208 — spec/behaviors/26-cli.md
  @BEH-EA-208
  Rule: The CLI reads the manifest; it never runs the application

    @REQ-EA-600
    Scenario Outline: Every CLI command operates on Auth.make's statically derived manifest, without evaluating any Layer
      Given "Auth.make"'s statically derived manifest for an installed plugin set
      When "<command>" runs
      Then it operates on the manifest's contract, tables, migrations, or plugin graph without evaluating the plugin set's runtime "make" Layer

      Examples:
        | command                          |
        | effect-auth doctor                |
        | effect-auth plugin list --graph   |
        | effect-auth routes                |
        | effect-auth migration status      |
        | effect-auth openapi               |

    @REQ-EA-601
    Scenario Outline: No CLI command starts an HTTP listener or accepts a request
      Given "Auth.make"'s statically derived manifest for an installed plugin set
      When "<command>" runs
      Then it does not start an HTTP listener, accept a request, or otherwise run the application it inspects

      Examples:
        | command                          |
        | effect-auth doctor                |
        | effect-auth plugin list --graph   |
        | effect-auth routes                |
        | effect-auth migration apply --yes |
        | effect-auth openapi               |
        | effect-auth seed admin            |

    @REQ-EA-602
    Scenario: The manifest exists the moment Auth.make is evaluated, before any server is listening
      Given an application defining "export const auth = Auth.make([Password, Passkey, OAuth, Organization, Roles])"
      When the module is evaluated
      Then "auth.manifest" is available for the CLI to read
      And no HTTP listener needs to be started and no database connection needs to be live for a CLI command to answer correctly
