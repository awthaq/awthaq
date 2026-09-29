# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@tooling @cli
@skip @unwired
Feature: CLI

  # BEH-EA-201 — spec/behaviors/26-cli.md
  @BEH-EA-201
  Rule: doctor checks link, config, and insecure defaults

    @REQ-EA-573
    Scenario: doctor reports every plugin-graph linking problem
      Given an installed plugin set with a missing declared dependency
      When "awthaq doctor" runs
      Then it reports the plugin-graph linking problem

    @REQ-EA-574
    Scenario: doctor reports every configuration value declared in the manifest's descriptors that the configuration module provides
      Given an application whose configuration module provides a value for a declared configuration descriptor
      When "awthaq doctor" runs
      Then it reports the result of auditing that configuration value through its descriptor

    @REQ-EA-575
    Scenario Outline: doctor reports each known insecure-default combination
      Given an application configured with <insecure default>
      When "awthaq doctor" runs
      Then it reports <insecure default> as an insecure default

      Examples:
        | insecure default                                          |
        | "sameSite" relaxed to "lax"                                |
        | a mutating endpoint without CSRF protection               |
        | an oversized request body limit                           |
        | a development mailer configured in a production environment |
        | a permissive rate limiter configured in a production environment |

    @REQ-EA-576
    Scenario: doctor produces its report without the application running
      Given an application that is not started, with no live process and no listening server
      When "awthaq doctor" runs
      Then it produces its full report
      And no running application instance is required

    @REQ-EA-633
    Scenario: doctor never prints a secret configuration value
      Given an OAuth client secret "sk-canary-123" and a database URL containing a password
      When "awthaq doctor" runs with human and JSON output
      Then the output contains neither the secret nor the password
      And the client secret is reported as present and valid

    @REQ-EA-634
    Scenario: doctor --build reports a build failure as a finding
      Given an application Layer that fails to build because a required port is not provided
      When "awthaq doctor --build" runs
      Then it reports the failure as a finding without serving the application

  # BEH-EA-202 — spec/behaviors/26-cli.md
  @BEH-EA-202
  Rule: plugin list --graph shows topology, ports, and hook chains

    @REQ-EA-577
    Scenario: plugin list --graph prints installed plugins in topological dependency order
      Given an installed plugin set including "password" and "oauth", where "oauth" depends on "password"
      When "awthaq plugin list --graph" runs
      Then "password" is printed before "oauth"

    @REQ-EA-578
    Scenario: plugin list --graph prints each plugin's required ports
      Given an installed plugin set including "oauth", which requires the "TokenStore" port
      When "awthaq plugin list --graph" runs
      Then "oauth"'s row lists "TokenStore" among its required ports

    @REQ-EA-579
    Scenario: plugin list --graph prints each plugin's resolved hook-tap chain
      Given an installed plugin set with taps registered on the "AfterSignUp" hook point
      When "awthaq plugin list --graph" runs
      Then the printed output includes the resolved tap chain for "AfterSignUp"

    @REQ-EA-580
    Scenario: The printed ordering matches the order the linker uses for migrations and hook resolution
      Given an installed plugin set composed by "Auth.make"
      When "awthaq plugin list --graph" prints the plugin order
      Then that printed order is identical to the order the linker uses to sequence migrations and resolve hook taps

  # BEH-EA-203 — spec/behaviors/26-cli.md
  @BEH-EA-203
  Rule: routes lists every endpoint with its owning plugin and middleware

    @REQ-EA-581
    Scenario: routes lists an endpoint with its method, path, group, plugin, and middleware chain
      Given a composed "AuthApi" contract with an endpoint "POST /password/sign-in" owned by group "password" and plugin "Password", protected by "RateLimiter" middleware
      When "awthaq routes" runs
      Then the listing includes a row for "POST /password/sign-in" carrying its method, path, owning group "password", owning plugin "Password", and its "RateLimiter" middleware

    @REQ-EA-582
    Scenario: routes omits no endpoint present in the compiled contract
      Given a composed "AuthApi" contract with a known number of endpoints across every installed plugin
      When "awthaq routes" runs
      Then the listing contains exactly one row per endpoint in the contract, with none omitted

    @REQ-EA-583
    Scenario: routes reads the compiled contract without making a request or running a handler
      Given a composed "AuthApi" contract
      When "awthaq routes" runs
      Then it produces its listing without making any HTTP request or running any handler

  # BEH-EA-204 — spec/behaviors/26-cli.md
  @BEH-EA-204
  Rule: migration status and apply read and advance the ledger

    @REQ-EA-584
    Scenario: migration status reports applied and pending migrations against the ledger
      Given the linker's ordered, re-keyed migration record for the installed plugin set
      And the driver's "Migrator" ledger showing some of those migrations already applied
      When "awthaq migration status" runs
      Then it reports each migration as applied or pending by comparing the linker's record against the ledger

    @REQ-EA-585
    Scenario: migration apply refuses to run without an explicit confirmation flag
      Given pending migrations reported by "awthaq migration status"
      When "awthaq migration apply" is run without the "--yes" flag
      Then it refuses to apply any migration

    @REQ-EA-586
    Scenario: migration apply proceeds once the explicit --yes flag is given
      Given pending migrations reported by "awthaq migration status"
      When "awthaq migration apply --yes" runs
      Then the pending migrations are applied

    @REQ-EA-587
    Scenario: migration apply applies migrations in the linker's fixed order
      Given an installed plugin set whose migrations are ordered core first, then topologically, keyed "NNNN_<plugin>_<name>"
      When "awthaq migration apply --yes" runs
      Then the migrations are applied in that exact fixed order

    @REQ-EA-635
    Scenario: migration apply prints the ordered pending plan before applying
      Given pending migrations reported by "awthaq migration status"
      When "awthaq migration apply --yes" runs
      Then the ordered pending set is printed before any migration is applied

    @REQ-EA-636
    Scenario: migration apply --dry-run applies nothing
      Given pending migrations reported by "awthaq migration status"
      When "awthaq migration apply --dry-run" runs
      Then the ordered pending set is printed
      And no migration is applied

    @REQ-EA-637
    Scenario: migration status reports drift when a ledger has an applied id the linker does not know
      Given a ledger holding an applied migration the linker's record does not contain
      When "awthaq migration status" runs
      Then it fails with the drift exit code

    @REQ-EA-638
    Scenario: migration apply refuses on drift
      Given a ledger holding an applied migration the linker's record does not contain
      When "awthaq migration apply --yes" runs
      Then it refuses to apply any migration
      And it fails with the drift exit code

    @REQ-EA-639
    Scenario: migration apply with nothing pending exits with the nothing-to-apply code
      Given no pending migrations
      When "awthaq migration apply --yes" runs
      Then it exits with the nothing-to-apply code

  # BEH-EA-205 — spec/behaviors/26-cli.md
  @BEH-EA-205
  Rule: openapi exports the aggregated document

    @REQ-EA-588
    Scenario: openapi emits one document covering core and every installed plugin's contract
      Given an installed plugin set including "password" and "oauth"
      When "awthaq openapi" runs
      Then it emits one OpenAPI document whose paths cover core's contract and both "password"'s and "oauth"'s contracts

    @REQ-EA-589
    Scenario: A non-Effect consumer never assembles multiple per-plugin documents themselves
      Given a consumer that does not import "effect" and wants to generate an HTTP client
      When that consumer uses the output of "awthaq openapi"
      Then it receives the single aggregated document
      And it is never required to assemble or merge multiple per-plugin OpenAPI documents itself

    @REQ-EA-590
    Scenario: The aggregated document is generated from the same merged AuthApi the Effect client is generated from
      Given the composed "AuthApi" contract used to generate the Effect-based client
      When "awthaq openapi" runs
      Then the emitted document is generated from that same merged contract

  # BEH-EA-206 — spec/behaviors/26-cli.md
  @BEH-EA-206
  Rule: seed admin provisions the first privileged account

    @REQ-EA-591
    Scenario: seed admin creates or promotes an account to admin through the Users and Roles domain services
      Given no administrative account exists yet
      When "awthaq seed admin" runs for account "ops@acme.com"
      Then the account is created or promoted to an administrative role through the "Users" and "Roles" domain services

    @REQ-EA-592
    Scenario: seed admin never writes rows directly to the database
      Given "awthaq seed admin" provisioning an account
      When it runs
      Then it does not write rows to the database directly, bypassing "Users" or "Roles"

    @REQ-EA-593
    Scenario: seed admin refuses to run when an administrative account already exists
      Given an administrative account already exists
      When "awthaq seed admin" runs without a force flag
      Then it refuses to create or promote another administrative account

    @REQ-EA-594
    Scenario: seed admin proceeds against an existing administrative account only when explicitly forced
      Given an administrative account already exists
      When "awthaq seed admin --force" runs
      Then it proceeds to create or promote the requested account

    @REQ-EA-595
    Scenario: seed admin has no admin concept to grant without the Roles plugin installed
      Given an installed plugin set that does not include "Roles"
      When "awthaq seed admin" runs
      Then there is no administrative role concept for it to grant

    @REQ-EA-640
    Scenario: seed admin records an auth.admin.seeded audit entry
      Given no administrative account exists yet
      When "awthaq seed admin" runs for account "ops@acme.com"
      Then an "auth.admin.seeded" event is published and recorded in the audit table

    @REQ-EA-641
    Scenario: a refused seed records auth.admin.seedRefused
      Given an administrative account already exists
      When "awthaq seed admin" runs without a force flag
      Then an "auth.admin.seedRefused" event is published and recorded in the audit table

    @REQ-EA-642
    Scenario: seed admin rejects a malformed email with a usage error
      Given an installed plugin set with "Roles"
      When "awthaq seed admin --email not-an-email" runs
      Then it fails with the usage exit code before any service is constructed

  # BEH-EA-207 — spec/behaviors/26-cli.md
  @BEH-EA-207
  Rule: import migrates users from a named source framework

    @REQ-EA-596
    Scenario Outline: import accepts each named source framework and translates a validated one
      Given an export from "<framework>"
      When "awthaq import --from <framework> --yes" runs
      Then the export is translated into awthaq's own Model.Class shapes if the adapter is validated
      And an adapter not yet validated against a real export is refused with a typed not-yet-validated error

      Examples:
        | framework   |
        | better-auth |
        | firebase    |
        | authjs      |
        | lucia       |

    @REQ-EA-597
    Scenario: A source field with no awthaq equivalent is reported rather than silently dropped
      Given a source export containing a field awthaq's Model.Class shapes have no equivalent for
      When "awthaq import" translates that export
      Then the unmapped field is reported to the operator
      And the field is not silently dropped

    @REQ-EA-598
    Scenario: awthaq import is planned CLI tooling the runtime does not depend on
      Given an application composing "Auth.make", "auth.layer", and "auth.migrations"
      When the application boots
      Then it does not depend on "awthaq import" existing

    @REQ-EA-599
    Scenario: import's source-framework mappings are not assumed correct without validation against real exports
      Given "awthaq import"'s mapping for "better-auth", "authjs", or "lucia"
      When that mapping is relied on for a production user-base migration
      Then it is expected to have been built and validated against a real export from that source first
      And it is not assumed correct from this specification alone

    @REQ-EA-643
    Scenario: import without --yes reports a plan and writes nothing
      Given a better-auth export with users and accounts
      When "awthaq import --from better-auth" runs without "--yes"
      Then per-table row counts, the unmapped-field report and conflict counts are printed
      And no row is written

    @REQ-EA-644
    Scenario: import --yes writes the previewed rows
      Given a better-auth export with users and accounts
      When "awthaq import --from better-auth --yes" runs
      Then the previewed rows are written through the Users and Accounts domain services

    @REQ-EA-645
    Scenario: a failing batch is rolled back and reported with its source row ids
      Given an import whose second batch fails
      When "awthaq import --from better-auth --yes" runs
      Then the failing batch is rolled back
      And it is reported with its source row ids and error tag
      And the checkpoint stays at the last committed batch

    @REQ-EA-646
    Scenario: a re-run resumes from the last committed batch without duplicating rows
      Given an import that stopped after a failed batch
      When "awthaq import --from better-auth --yes" runs again against the same source
      Then rows already imported are skipped and never inserted twice

    @REQ-EA-647
    Scenario: a completed import publishes auth.import.completed
      Given a better-auth export with users and accounts
      When "awthaq import --from better-auth --yes" completes
      Then one "auth.import.completed" event carrying the run id and counts is published

    @REQ-EA-648
    Scenario: import rejects an unknown --from value listing the supported sources
      Given no adapter registered under "mystery"
      When "awthaq import --from mystery" runs
      Then it fails with the usage exit code listing the supported sources

  # BEH-EA-208 — spec/behaviors/26-cli.md
  @BEH-EA-208
  Rule: The CLI reads the manifest; it never runs the application

    @REQ-EA-600
    Scenario Outline: Every manifest-only CLI command operates on Auth.make's statically derived manifest, without evaluating any Layer
      Given "Auth.make"'s statically derived manifest for an installed plugin set
      When "<command>" runs
      Then it operates on the manifest's contract, tables, migrations, or plugin graph without evaluating the plugin set's runtime "make" Layer

      Examples:
        | command                          |
        | awthaq doctor                |
        | awthaq config list           |
        | awthaq plugin list --graph   |
        | awthaq routes                |
        | awthaq openapi               |

    @REQ-EA-601
    Scenario Outline: No CLI command starts an HTTP listener or accepts an inbound request
      Given "Auth.make"'s statically derived manifest for an installed plugin set
      When "<command>" runs
      Then it does not start an HTTP listener, accept an inbound request, or otherwise serve the application it acts on

      Examples:
        | command                          |
        | awthaq doctor                |
        | awthaq plugin list --graph   |
        | awthaq routes                |
        | awthaq migration apply --yes |
        | awthaq openapi               |
        | awthaq seed admin            |

    @REQ-EA-602
    Scenario: The manifest exists the moment Auth.make is evaluated, before any server is listening
      Given an application defining "export const auth = Auth.make([Password, Passkey, OAuth, Organization, Roles])"
      When the module is evaluated
      Then "auth.manifest" is available for the CLI to read
      And no HTTP listener needs to be started and no database connection needs to be live for a manifest-only CLI command to answer correctly

    @REQ-EA-649
    Scenario: database-backed commands construct only SqlClient and domain-service Layers, never the HTTP server Layer
      Given a database-backed command among "migration status", "migration apply", "seed admin" and "import"
      When the command runs
      Then it may construct the SqlClient and the Users, Roles and Accounts domain-service Layers
      And it never builds the HTTP server Layer

  # BEH-EA-225 — spec/behaviors/26-cli.md
  @BEH-EA-225
  Rule: Every CLI command exits with a stable, typed exit code

    @REQ-EA-650
    Scenario Outline: A typed failure maps to its exit code
      Given a CLI command that fails with "<error>"
      When it exits
      Then the process exit status is <code>

      Examples:
        | error                | code |
        | DoctorFindings       | 3    |
        | NothingToApply       | 4    |
        | ConfirmationRequired | 6    |
        | LedgerDrift          | 7    |
        | AuthenticationRequired | 8  |
        | ConfigUnavailable    | 9    |

    @REQ-EA-651
    Scenario: doctor on a clean configuration exits 0
      Given a configuration with no findings
      When "awthaq doctor" runs
      Then the process exits with status 0

    @REQ-EA-652
    Scenario: a bad flag exits with the usage code
      Given a command invoked with an unknown flag
      When it runs
      Then the process exits with the usage code

    @REQ-EA-653
    Scenario: --json output carries the failure tag and code
      Given a failing command run with "--json"
      When it fails
      Then the failure document carries the same "_tag" and exit code

  # BEH-EA-226 — spec/behaviors/26-cli.md
  @BEH-EA-226
  Rule: CLI arguments decode through the contract's Schemas

    @REQ-EA-654
    Scenario: every flag and argument is declared with a Schema
      Given the CLI's command tree
      When its flags and arguments are inspected
      Then each one decodes through a Schema

    @REQ-EA-655
    Scenario: seed admin --email reuses the sign-up payload's email Schema
      Given the password sign-up payload's email Schema
      When "awthaq seed admin --email <value>" decodes its argument
      Then it accepts and rejects exactly the values that Schema accepts and rejects

  # BEH-EA-227 — spec/behaviors/26-cli.md
  @BEH-EA-227
  Rule: Session commands are outbound-only clients of a running auth server

    @REQ-EA-656
    Scenario: login polls the device endpoint as an outbound client and never opens a listener
      Given a running auth server offering the device authorization endpoints
      When "awthaq login" runs
      Then it polls "/device/token" as an outbound client
      And it never starts a listener

    @REQ-EA-657
    Scenario: login honors slow_down
      Given a device token endpoint that answers "slow_down"
      When "awthaq login" polls
      Then the poll interval widens

    @REQ-EA-658
    Scenario: login exits non-zero on expired_token
      Given a device token endpoint that answers "expired_token"
      When "awthaq login" polls
      Then it exits with the authentication code
      And it tells the user to run "awthaq login" again

    @REQ-EA-659
    Scenario: AWTHAQ_TOKEN bypasses the device flow and the credential store
      Given "AWTHAQ_TOKEN" is set to a valid token
      When "awthaq whoami" runs
      Then it uses that token without contacting the device endpoints
      And it never writes the credential store

    @REQ-EA-660
    Scenario: login --token stores nothing when the token is invalid
      Given a token the server rejects
      When "awthaq login --token" runs
      Then it fails with the authentication code
      And nothing is stored

    @REQ-EA-661
    Scenario: whoami exits with the authentication code when not logged in
      Given no stored credential and no "AWTHAQ_TOKEN"
      When "awthaq whoami" runs
      Then it fails with the authentication code

  # BEH-EA-228 — spec/behaviors/26-cli.md
  @BEH-EA-228
  Rule: CLI credentials live in a CredentialStore, never a plaintext dotfile by default

    @REQ-EA-662
    Scenario: login stores the credential in the OS keychain when available
      Given a reachable OS-native credential store
      When "awthaq login --token" succeeds
      Then the credential is stored there and no credentials file is written

    @REQ-EA-663
    Scenario: the fallback credentials file is created 0600 and a warning is printed
      Given no reachable OS-native credential store
      When "awthaq login --token" succeeds
      Then "credentials.json" is created with mode 0600 in a 0700 directory
      And a warning is printed once

    @REQ-EA-664
    Scenario: AWTHAQ_TOKEN is never persisted
      Given "AWTHAQ_TOKEN" is set
      When any session command runs
      Then no credential store is written

  # BEH-EA-229 — spec/behaviors/26-cli.md
  @BEH-EA-229
  Rule: Plugins declare their configuration statically, and config list prints it redacted

    @REQ-EA-665
    Scenario: the manifest lists a plugin's configuration descriptors without building any Layer
      Given an installed plugin that declares a configuration descriptor
      When "Auth.make" is evaluated
      Then "auth.manifest.config" lists the descriptor without evaluating any Layer

    @REQ-EA-666
    Scenario: config list never prints a sensitive value
      Given a configuration Layer setting a value declared sensitive
      When "awthaq config list" runs
      Then the sensitive value is printed as "<redacted>"
