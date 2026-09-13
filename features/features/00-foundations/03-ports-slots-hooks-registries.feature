# effect-auth is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@foundations @ports-slots-hooks-registries
Feature: Ports, Slots, Hook Points, and Registries

  # BEH-EA-017 — spec/behaviors/03-ports-slots-hooks-registries.md; see also
  # ADR-EA-011, ADR-EA-006.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-017 @compile-time
  Rule: Configuration is a Context.Reference with a default value

    @REQ-EA-036
    Scenario: A plugin's options are modeled as a Context.Reference carrying a default value, not constructor arguments
      Given a plugin "Password" whose options are declared as "PasswordConfig", a "Context.Reference" with a "defaultValue"
      When "Password"'s options are inspected
      Then the options are a "Context.Reference", not arguments to a factory function

    @REQ-EA-037
    Scenario: A missing configuration override resolves to the default value, never an error
      Given a plugin "Password" whose "PasswordConfig" declares "defaultValue: () => ({ minLength: 12, ... })"
      When no "Password.config(...)" override is provided
      Then "PasswordConfig" resolves to its declared default value
      And no error is produced for the missing override

    @REQ-EA-038
    Scenario: Per-tenant configuration overrides compose via ordinary Layer.provide, needing no new mechanism
      Given a "TenantAuthConfig" composed via "LayerMap.Service" from tenant-specific "Password.config(...)" Layers
      When a request is scoped to a given tenant
      Then that tenant's "Password.config(...)" override is provided the same way any application "Layer.provide" would be
      And no plugin-specific override mechanism is required

  # BEH-EA-018 — spec/behaviors/03-ports-slots-hooks-registries.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-018 @compile-time
  Rule: An invalid configuration override is a type error against the reference's shape, not a runtime validation failure

    @REQ-EA-039
    Scenario: A field of the wrong type in a configuration override is rejected by the compiler at the call site
      Given "PasswordConfig"'s declared shape requires "minLength" to be a number
      When "Password.config({ minLength: "twelve" })" is written
      Then the call site fails to type-check

    @REQ-EA-040
    Scenario: An unknown key in a configuration override is rejected by the compiler at the call site
      Given "PasswordConfig"'s declared shape does not include a key "unknownOption"
      When "Password.config({ unknownOption: true })" is written
      Then the call site fails to type-check

    @REQ-EA-041
    Scenario: A wrong override is never accepted and later discovered invalid at boot or first use
      Given a wrong-typed "Password.config(...)" override
      When the application is composed and run
      Then the override was already rejected at the call site
      And no runtime validation failure occurs at boot or at first use for this override

  # BEH-EA-019 — spec/behaviors/03-ports-slots-hooks-registries.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-019 @compile-time
  Rule: Variants are alternative static layers that remove requirements from RIn

    @REQ-EA-042
    Scenario: Auth.make accepts a plugin variant in place of the plugin class itself
      Given a plugin "Password" exposing a static variant "Password.layerNoReset" alongside its full "Password.layer"
      When "Password.layerNoReset" is passed to "Auth.make" in place of "Password"
      Then "Auth.make" accepts "Password.layerNoReset" as a valid tuple entry

    @REQ-EA-043
    Scenario: A chosen variant's narrower requirements are visible in auth.layer's type
      Given "Password.layerNoReset" whose "make" never reads "Mailer"
      When "Auth.make([Password.layerNoReset, Passkey])" composes the tuple
      Then "auth.layer"'s type does not include "Mailer" in its "RIn"

  # BEH-EA-020 — spec/behaviors/03-ports-slots-hooks-registries.md; see also
  # ADR-EA-010.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-020 @compile-time
  Rule: Ports are required in RIn and never provided by a plugin's ROut

    @REQ-EA-044
    Scenario: A plugin using a port keeps that port in its Layer's RIn until the application provides it
      Given a plugin "Password" whose "make" uses the port "PasswordHasher"
      When "Password"'s "layer" type is inspected before the application provides "PasswordHasher"
      Then "PasswordHasher" remains in "Password"'s Layer "RIn"

    @REQ-EA-045
    Scenario: No plugin's Layer includes a port service in its own ROut
      Given a plugin "Password" whose "make" uses the ports "PasswordHasher" and "Mailer"
      When "Password"'s Layer "ROut" is inspected
      Then neither "PasswordHasher" nor "Mailer" appears in "Password"'s Layer "ROut"

    @REQ-EA-046
    Scenario: Two plugins requiring the same port never conflict, because both keep it in RIn rather than provide it
      Given two plugins "Password" and "Passkey" that both use the port "Crypto"
      When both are composed by "Auth.make"
      Then "Crypto" remains a single shared entry in the composed Layer's "RIn"
      And no slot-conflict-style failure occurs between "Password" and "Passkey" over "Crypto"

  # BEH-EA-021 — spec/behaviors/03-ports-slots-hooks-registries.md; see also
  # ADR-EA-012.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-021 @compile-time
  Rule: A slot is a Context.Reference with a fail-closed default that at most one plugin may override

    @REQ-EA-047
    Scenario: With no installed plugin overriding the slot, the slot resolves to its fail-closed default
      Given no installed plugin overrides the "SubjectResolver" slot
      When "SubjectResolver" is resolved
      Then it resolves to the "identity only" default, granting no roles and no permissions beyond the subject's own id

    @REQ-EA-048
    Scenario: A slot's default never grants broader access than an explicit override would
      Given the "SubjectResolver" slot's declared default value
      When the default is compared against any plugin's explicit "SubjectResolver" override
      Then the default is at least as restrictive as any explicit override

    @REQ-EA-049
    Scenario: Overriding a slot places it in the overriding plugin's Layer ROut, making two overrides pairwise-detectable
      Given a plugin "Roles" that overrides the "SubjectResolver" slot
      When "Roles"'s Layer "ROut" is inspected
      Then "SubjectResolver" appears in "Roles"'s Layer "ROut"
      And a second plugin also overriding "SubjectResolver" is thereby detectable pairwise (BEH-EA-012)

  # BEH-EA-022 — spec/behaviors/03-ports-slots-hooks-registries.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-022 @compile-time
  Rule: A veto hook point may abort or amend, and its taps run in dependency order

    @REQ-EA-050
    Scenario: A veto tap aborts the operation with a typed HookAbort
      Given a "veto" hook point "BeforeSignUp" tapped by "CompanyEmail", which fails with "HookAbort" when the email does not end in "@acme.com"
      When "BeforeSignUp" fires for an input whose email ends in "@other.com"
      Then the operation is aborted with the typed "HookAbort" "EMAIL_DOMAIN_NOT_ALLOWED"

    @REQ-EA-051
    Scenario: A veto tap returns a transformed value that later taps and the operation observe
      Given a "veto" hook point "BeforeSignUp" tapped by a plugin that transforms the input and does not abort
      When "BeforeSignUp" fires
      Then later taps observe the transformed value
      And the operation itself observes the transformed value

    @REQ-EA-052
    Scenario: Taps at one hook point run in dependency order, then declared order, then plugin id
      Given a "veto" hook point tapped by plugin "B" (declared order 2), plugin "A" (declared order 1, depends on "B"), and plugin "C" (declared order 1)
      When the hook point fires
      Then taps run in an order that places "B" before "A" (dependency order)
      And, among taps with no dependency relationship, taps run by declared "order" and then by plugin id

  # BEH-EA-023 — spec/behaviors/03-ports-slots-hooks-registries.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-023 @compile-time
  Rule: An observe hook point is fail-isolated; a divert hook point returns a typed alternative outcome

    @REQ-EA-053
    Scenario: A failing observe tap does not fail the operation it observes
      Given an "observe" hook point "AfterSignIn" tapped by "Welcome", which throws while sending a welcome email
      When "AfterSignIn" fires after a successful sign-in
      Then the sign-in operation still succeeds
      And "Welcome"'s failure is isolated from the operation's outcome

    @REQ-EA-054
    Scenario: A divert tap returns a typed alternative outcome the caller is required to handle
      Given a "divert" hook point tapped by a plugin that turns an ordinary sign-in into a "TwoFactorRequired" outcome
      When the divert tap returns "TwoFactorRequired" instead of the operation's ordinary success value
      Then the caller receives "TwoFactorRequired" as a typed alternative outcome
      And the caller is required to handle "TwoFactorRequired" for the call to type-check

  # BEH-EA-024 — spec/behaviors/03-ports-slots-hooks-registries.md; see also
  # INV-EA-005.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-024 @compile-time
  Rule: Tapping a hook point nobody defines is a compile error, and registries aggregate through Layer.effectDiscard, ordered and frozen at first read

    @REQ-EA-055
    Scenario: Tapping a hook point places that point's service in the tapping plugin's Layer RIn
      Given a plugin "Invite" that taps the hook point "BeforeUserDelete"
      When "Invite"'s Layer type is inspected
      Then "BeforeUserDelete" appears in "Invite"'s Layer "RIn"

    @REQ-EA-056
    Scenario: Tapping a hook point nobody defines fails to compile, the same way as a missing port
      Given a plugin "Invite" that taps a hook point no installed plugin's Layer provides in its ROut
      When the composed application Layer is type-checked
      Then it fails to compile
      And the failure is the same shape as a missing-port failure (BEH-EA-014)

    @REQ-EA-057
    Scenario: A registry aggregates contributions from multiple plugins, ordered by dependency, then declared order, then plugin id
      Given a registry "RateLimits" contributed to by plugin "Invite" (order 10) and plugin "Password" (order 5, no dependency relationship)
      When the registry's contributions are aggregated via "Layer.effectDiscard"
      Then the aggregated writes are ordered by dependency first, then by declared "order", then by plugin id

    @REQ-EA-058
    Scenario: A registry freezes at first read
      Given a registry "RateLimits" that has already been read once by the application
      When another plugin's Layer attempts to contribute a new rule to "RateLimits" after that first read
      Then the registry's contents no longer change for any subsequent read
