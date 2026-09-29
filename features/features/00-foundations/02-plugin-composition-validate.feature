# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@foundations @plugin-composition
Feature: Plugin Composition and Validate<P>

  # BEH-EA-009 — spec/behaviors/02-plugin-composition-validate.md; see also
  # ADR-EA-002, ADR-EA-008.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-009 @compile-time
  Rule: Auth.make computes three outputs from one plugin tuple

    @REQ-EA-018
    Scenario: A self-sufficient plugin tuple composes successfully
      Given a plugin tuple containing "Password" and its declared dependency "Core"
      When "Auth.make" composes the tuple
      Then composition succeeds and produces "api", "layer", "migrations", and "manifest"

    @REQ-EA-019
    Scenario: Adding a plugin to the tuple extends the api's groups and the layer's handlers together
      Given a plugin tuple already composed by "Auth.make"
      When a plugin contributing a new contract group and its handler is added to the tuple
      Then the recomputed "auth.api" gains that group
      And the recomputed "auth.layer" gains that group's handler in the same composition

  # BEH-EA-010 — spec/behaviors/02-plugin-composition-validate.md; see also
  # INV-EA-003.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-010 @compile-time
  Rule: Validate<P>'s DuplicateId check refuses two plugins sharing an id

    @REQ-EA-020
    Scenario: Two plugins declaring the same id fail composition, naming the duplicate
      Given a plugin tuple containing two plugins both declaring id "invite"
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection narrows the tuple's type to a literal string naming "invite" as the duplicated id

    @REQ-EA-021
    Scenario: A duplicate-id rejection is reported before Layer.launch is ever reached
      Given a plugin tuple containing two plugins both declaring id "invite"
      When "Auth.make" composes the tuple
      Then composition is rejected at the "Auth.make" call site
      And no "Layer.launch" step is ever reached for this tuple

  # BEH-EA-011 — spec/behaviors/02-plugin-composition-validate.md; see also
  # INV-EA-001.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-011 @compile-time
  Rule: Validate<P>'s MissingDep check names an absent dependency by plugin id

    @REQ-EA-022
    Scenario: A missing plugin dependency fails composition, naming the missing plugin and its dependent
      Given a plugin tuple containing "TwoFactor" without its declared dependency "Password"
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "Password" as the missing dependency of "TwoFactor"

    @REQ-EA-023
    Scenario: A plugin tuple containing every declared dependency composes without a missing-dependency failure
      Given a plugin tuple containing "TwoFactor" and its declared dependency "Password"
      When "Auth.make" composes the tuple
      Then composition succeeds

    @REQ-EA-024
    Scenario: The missing-dependency diagnostic names the plugin rather than reporting an opaque unsatisfied requirement
      Given a plugin tuple containing "TwoFactor" without its declared dependency "Password"
      When "Auth.make" composes the tuple
      Then the rejection is a literal string naming both "Password" and "TwoFactor"
      And the rejection is not merely an opaque unsatisfied service requirement

    @REQ-EA-682
    Scenario: A dependent listed before its dependency fails composition at compile time
      Given a plugin tuple listing "TwoFactor" before its declared dependency "Password"
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "Password" as a plugin that must be listed before "TwoFactor"

  # BEH-EA-012 — spec/behaviors/02-plugin-composition-validate.md; see also
  # INV-EA-004.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-012 @compile-time
  Rule: Validate<P>'s SlotConflict check refuses two plugins overriding one exclusive slot

    @REQ-EA-025
    Scenario: Two plugins overriding the same exclusive slot fail composition, naming both and the slot
      Given a plugin tuple containing "Roles" and "Organization", both overriding the "SubjectResolver" slot
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "Roles", "Organization", and "SubjectResolver"

    @REQ-EA-026
    Scenario: Two plugins overriding distinct slots compose without a slot-conflict failure
      Given a plugin tuple containing "Roles" overriding the "SubjectResolver" slot and another plugin overriding a distinct slot
      When "Auth.make" composes the tuple
      Then composition succeeds

    @REQ-EA-683
    Scenario: The slot-conflict check runs without the application providing a slots registry
      Given a plugin tuple containing "Roles" and "Organization", both overriding the "SubjectResolver" slot
      When the composed layer is built without any explicit "Slots.layer"
      Then the build fails with a "SlotConflict" naming both owners

  # BEH-EA-013 — spec/behaviors/02-plugin-composition-validate.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-013 @compile-time
  Rule: api and layer diverging from one another is unrepresentable, not merely untested

    @REQ-EA-027
    Scenario: Every group in auth.api has a corresponding handler service in auth.layer
      Given "auth" produced by "Auth.make" from a plugin tuple "P"
      When "auth.api"'s groups are compared against "auth.layer"'s "ROut"
      Then no group in "auth.api" lacks a handler service in "auth.layer"'s "ROut"

    @REQ-EA-028
    Scenario: Every handler service in auth.layer corresponds to a group auth.api declares
      Given "auth" produced by "Auth.make" from a plugin tuple "P"
      When "auth.layer"'s "ROut" is compared against "auth.api"'s groups
      Then no handler service in "auth.layer"'s "ROut" lacks a corresponding group in "auth.api"

  # BEH-EA-014 — spec/behaviors/02-plugin-composition-validate.md; see also
  # INV-EA-002.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-014 @compile-time
  Rule: Layer.launch refuses to compile while any port remains unprovided

    @REQ-EA-029
    Scenario: Launching without providing a required port fails to type-check, listing every unprovided port
      Given "auth.layer" produced by "Auth.make([Password, Passkey])" with unprovided ports "Mailer" and "PasswordHasher"
      When the application calls "Layer.launch" on "auth.layer" without providing those ports
      Then the call fails to type-check
      And the diagnostic lists "Mailer" and "PasswordHasher" as unsatisfied requirements

    @REQ-EA-030
    Scenario: Removing a previously-provided port's Layer line turns a compiling application into one that fails to compile
      Given an application that provides "Mailer.layerSes" to "auth.layer" and compiles successfully
      When the "Layer.provide(Mailer.layerSes)" line is removed from the application's wiring
      Then "Layer.launch" fails to type-check
      And the diagnostic names "Mailer" as the unsatisfied requirement

    @REQ-EA-031
    Scenario: A missing-port diagnostic is Effect's ordinary Layer diagnostic, distinct from Auth.make's curated diagnostics
      Given "auth.layer" produced by "Auth.make" with an unprovided port
      When the application calls "Layer.launch" without providing that port
      Then the diagnostic is Effect's ordinary "is not assignable to" Layer diagnostic naming the unsatisfied service
      And the diagnostic is not one of "Auth.make"'s curated duplicate-id, missing-dependency, or slot-conflict strings

  # BEH-EA-015 — spec/behaviors/02-plugin-composition-validate.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the compiler-checked half is proven in
  # features/step-definitions/PluginTypeGates.ts (compiled by the typecheck gate),
  # and each step also asserts its runtime shadow where one exists.
  @BEH-EA-015 @compile-time
  Rule: A plugin definition itself, not Auth.make, is where a namespace violation is caught

    @REQ-EA-032
    Scenario: A plugin whose contract names a group outside its own namespace fails at its own class definition
      Given a plugin "Invite" declared with id "acme.invite" whose contract adds an "HttpApiGroup" named "invitations"
      When the "Invite" class is defined
      Then the class definition fails to type-check
      And "Invite" can never be expressed as a value that reaches "Auth.make"

    @REQ-EA-033
    Scenario: A namespace violation needs no information about any other plugin to be caught
      Given a plugin "Invite" whose contract names a group outside its own namespace, defined in isolation from any other plugin
      When the "Invite" class is defined
      Then the class definition fails to type-check without composing "Invite" with any other plugin
      And the failure occurs earlier than any "Auth.make"-site check over a composed tuple (duplicate id, missing dependency, slot conflict)

  # BEH-EA-016 — spec/behaviors/02-plugin-composition-validate.md
  # This Rule is the one exception in this file's compile-time convention:
  # its own source heading states these two checks run "as a runtime step,
  # not a type-level one" — cycle detection and migration ordering are
  # performed by the linker's Kahn's-algorithm walk when Auth.make executes,
  # not by the TypeScript compiler. Scenarios below are written as ordinary
  # runtime behavior, without the @compile-time note.
  @BEH-EA-016
  Rule: The linker still performs two runtime checks the type system cannot express — cycle detection and migration ordering

    @REQ-EA-034
    Scenario: An acyclic dependsOn graph derives a migration order with core first, then plugins in topological order
      Given a composed application of core plugins "Users", "Accounts", "Sessions" and installed plugins "Password" and "Sessions2FA" whose "dependsOn" graph is acyclic
      When "Auth.make" runs its linker step
      Then the derived migration order places all core migrations before any plugin migrations
      And plugin migrations follow the "dependsOn" graph's topological order
      And every migration key is rewritten "NNNN_<plugin>_<name>"

    @REQ-EA-035
    Scenario: A cyclic dependsOn graph is detected at Auth.make and reported with the full cycle path
      Given a plugin tuple whose "dependsOn" declarations form a cycle "A" depends on "B", "B" depends on "C", "C" depends on "A"
      When "Auth.make" runs Kahn's algorithm over the composed "dependsOn" graph
      Then a cycle is detected
      And the report names the full cycle path "A" -> "B" -> "C" -> "A"
