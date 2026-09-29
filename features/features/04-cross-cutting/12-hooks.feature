# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@cross-cutting @hooks
Feature: Hooks

  # BEH-EA-089 — spec/behaviors/12-hooks.md; see also ADR-EA-001.
  @BEH-EA-089
  Rule: A hook point is declared as a service carrying its own kind

    # Compile-time: proven by the `// type-gate:` blocks in step-definitions/CompileTimeGates.ts.
    @REQ-EA-242
    Scenario: Defining a hook point requires declaring a kind of "veto", "observe", or "divert"
      Given a "HookPoint.Service" definition that omits a "kind"
      When the hook point class is defined
      Then the definition fails to compile, naming "kind" as required

    @REQ-EA-243
    Scenario: Defining a hook point requires declaring an input schema
      Given a "HookPoint.Service" definition that declares a "kind" but omits an "input" schema
      When the hook point class is defined
      Then the definition fails to compile, naming "input" as required

    @REQ-EA-244
    Scenario: A hook point's failure semantics are fixed at its own definition, not by whichever plugin taps it
      Given a "kind: \"veto\"" hook point "BeforeSignUp" defined by core
      When an unrelated plugin later taps "BeforeSignUp"
      Then the tap cannot change "BeforeSignUp"'s "kind" away from "veto"
      And the point's failure semantics remain exactly as core defined them

  # BEH-EA-090 — spec/behaviors/12-hooks.md
  @BEH-EA-090
  Rule: A veto tap may abort the operation with a typed HookAbort

    @REQ-EA-245
    Scenario: A veto tap rejects an operation with a typed HookAbort naming a code
      Given a "kind: \"veto\"" hook point "BeforeSignUp" tapped by "CompanyEmail", which rejects any email outside "@acme.com"
      When a sign-up is attempted with an email outside "@acme.com"
      Then the sign-up operation is stopped
      And the caller receives a "HookAbort" failure whose code is "EMAIL_DOMAIN_NOT_ALLOWED"

    @REQ-EA-246
    Scenario: A HookAbort surfaces to the caller as a structured code and message, not a generic failure
      Given "CompanyEmail" rejects a sign-up attempt with "HookAbort.fail({ code: \"EMAIL_DOMAIN_NOT_ALLOWED\" })"
      When the caller receives the failure
      Then the failure is a structured value carrying "code" and "message"
      And the failure is not a generic or untyped error

  # BEH-EA-091 — spec/behaviors/12-hooks.md
  @BEH-EA-091
  Rule: A veto tap may instead amend the value, and multiple taps on one point run in dependency order

    @REQ-EA-247
    Scenario: An amended value from a veto tap is observed by subsequent taps and by the operation itself
      Given "BeforeSignUp" is tapped by "Normalize", which lowercases the input email, with declared order "pre"
      And "BeforeSignUp" is also tapped by "CompanyEmail", which checks the domain of the email it receives
      When a sign-up is attempted with email "Alice@ACME.com"
      Then "CompanyEmail" observes the lowercased email "alice@acme.com" in place of the original
      And the sign-up operation itself observes the lowercased email

    @REQ-EA-248
    Scenario: Taps on one point resolve their run order by dependency order, then declared order, then plugin id
      Given three taps registered on "BeforeSignUp" by plugins "acme.audit", "acme.normalize", and "acme.gate"
      And "acme.gate" depends on "acme.normalize"
      And "acme.normalize" declares order "pre"
      When the tap chain for "BeforeSignUp" is resolved
      Then "acme.normalize" runs before "acme.gate" because of the dependency relationship
      And taps with no dependency relationship between them are ordered next by declared "order"
      And any remaining tie is broken by plugin id

  # BEH-EA-092 — spec/behaviors/12-hooks.md
  @BEH-EA-092
  Rule: An observe tap is fail-isolated — a throwing observer cannot fail the operation it observes

    @REQ-EA-249
    Scenario: A throwing observe tap does not fail the operation it observes
      Given a "kind: \"observe\"" hook point "AfterSignUp" tapped by "Welcome", which fails while sending its welcome email because its "Mailer" is unavailable
      When a sign-up completes and "Welcome" fails while handling it
      Then the sign-up operation itself succeeds
      And "Welcome"'s failure does not propagate to the sign-up operation

    @REQ-EA-250
    Scenario: A failing observe tap's failure is caught and logged, not silently dropped
      Given the same "Welcome" tap fails while handling "AfterSignUp"
      When its failure occurs
      Then the failure is caught
      And the failure is logged

  # BEH-EA-093 — spec/behaviors/12-hooks.md
  @BEH-EA-093
  Rule: A divert tap returns a typed alternative outcome the caller must handle

    @REQ-EA-251
    Scenario: A divert tap redirects sign-in to a distinct typed outcome, not an ordinary success or failure
      Given the "kind: \"divert\"" hook point "BeforeSessionIssue" is tapped by the two-factor plugin's step-up tap
      And a signed-in user "alice" has two-factor enabled
      When "alice" signs in with a valid password
      Then the sign-in call resolves to a "TwoFactorRequired" outcome
      And this outcome is neither the sign-in operation's ordinary success value nor an ordinary failure

    @REQ-EA-252
    Scenario: A caller pattern-matches on a diverted outcome the same way it matches on any other tagged result
      Given a "TwoFactorRequired" diverted outcome from "alice"'s sign-in attempt
      When the caller handles the sign-in call's result with "Effect.catchTag(\"TwoFactorRequired\", ...)"
      Then the caller catches "TwoFactorRequired" by tag exactly as it would catch any other tagged result
      And the caller answers it with a follow-up call rather than treating it as success or failure

  # BEH-EA-094 — spec/behaviors/12-hooks.md; see also INV-EA-005.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-094 @compile-time
  Rule: Tapping a hook point nobody defines is a type error, not a silent no-op

    # Compile-time: proven by the `// type-gate:` blocks in step-definitions/CompileTimeGates.ts.
    @REQ-EA-253
    Scenario: A tap on a hook point no installed plugin defines keeps that point's service in the composed Layer's RIn
      Given a plugin tuple where no installed plugin's Layer provides "SomeHookPoint" in its "ROut"
      And a tap is registered on "SomeHookPoint"
      When the tuple is composed
      Then "SomeHookPoint" remains in the composed Layer's "RIn"
      And composition fails to compile, identical in kind to a missing port

    @REQ-EA-254
    Scenario: A tap left on a hook point after its defining plugin is uninstalled is a compile error, not a silent no-op
      Given a tap registered on a hook point that "Invite" used to define
      When "Invite" is removed from the installed plugin tuple
      Then the tap's Layer fails to compile
      And the tap does not silently become a no-op that fires zero times

  # BEH-EA-095 — spec/behaviors/12-hooks.md; see also INV-EA-016.
  @BEH-EA-095
  Rule: A shared table's hook-mediated extension is the only way a plugin observes another plugin's core data without altering its table

    @REQ-EA-255
    Scenario: A plugin reacts to a core data change by tapping the hook point core exposes for it
      Given "Invite" needs to purge its own invitations when a user is deleted
      When "Invite" taps "BeforeUserDelete" to purge its own "acme.invite_invitation" rows for that user
      Then "Invite"'s reaction runs entirely through the tap on "BeforeUserDelete"
      And no foreign key or database-level cascade into a core table is required

    @REQ-EA-256
    Scenario: A plugin migrating or altering a core-owned table directly, bypassing any hook point, is rejected
      Given "Invite"'s migration attempts to alter the "users" table directly instead of tapping "BeforeUserDelete"
      When migration ownership is checked
      Then the migration is rejected as touching a table outside "Invite"'s own prefix
      And "Invite"'s only sanctioned path to react to a user deletion remains tapping "BeforeUserDelete"

  # BEH-EA-096 — spec/behaviors/12-hooks.md
  @BEH-EA-096
  Rule: The resolved order of every hook point's taps is introspectable without running any code

    @REQ-EA-257
    Scenario: The resolved tap order for every hook point is printable by the CLI without executing any tap
      Given an application composed from a plugin tuple with taps registered on multiple hook points
      When the composed application's manifest is read for its resolved hook order
      Then it reports the fully resolved tap order for each hook point
      And no tap is executed to produce that report

    @REQ-EA-258
    Scenario: The resolved order is derived only from static facts already known off the plugin tuple
      Given the same composed application
      When the resolved tap order is computed
      Then it uses only each plugin's declared "dependsOn", each tap's declared "order", and each plugin's "id"
      And no running application is needed to observe it
