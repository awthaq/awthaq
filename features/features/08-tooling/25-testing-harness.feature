# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@tooling @testing-harness
@skip @unwired
Feature: Testing Harness

  # BEH-EA-193 — spec/behaviors/25-testing-harness.md
  @BEH-EA-193
  Rule: TestAuth.layer is the whole pipeline, over memory

    @REQ-EA-545
    Scenario: TestAuth.layer assembles the named plugins over in-memory backends
      Given a plugin tuple containing "Password" and "Session"
      When "TestAuth.layer" composes the tuple
      Then the composed layer uses memory repositories, "Mailer.layerMemory", a permissive "RateLimiter", and "HttpServer.layerServices"

    @REQ-EA-546
    Scenario Outline: A test built on TestAuth.layer needs no real backing <dependency>
      Given a test built on "TestAuth.layer(plugins)"
      When the test runs
      Then it does not require a real <dependency>

      Examples:
        | dependency        |
        | database          |
        | mailer             |
        | network listener   |

    @REQ-EA-547
    Scenario: A TestAuth.layer test exercises the same plugin graph the application composes
      Given an application's own plugin tuple passed to "Auth.make"
      When a test composes that same tuple through "TestAuth.layer"
      Then the test exercises the actual plugin graph "Auth.make" produces
      And a failure in the test is a fact about the plugin wiring, not an artifact of a stubbed-out shortcut

  # BEH-EA-194 — spec/behaviors/25-testing-harness.md
  @BEH-EA-194
  Rule: HttpApiTest.groups runs under TestClock

    @REQ-EA-548
    Scenario Outline: A whole-pipeline HTTP test advances time via TestClock for every duration-based invariant
      Given a whole-pipeline HTTP test asserting <invariant>
      When the test needs to elapse time to observe the boundary
      Then it advances "TestClock" rather than waiting in real time

      Examples:
        | invariant                  |
        | session idle expiry        |
        | verification token TTL     |
        | passkey challenge expiry   |
        | a rate-limit window        |

    @REQ-EA-549
    Scenario: A time-dependent HTTP test never uses a real sleep to elapse time
      Given a whole-pipeline HTTP test asserting an eight-day session expiry
      When the test elapses that time
      Then it does not call a real "sleep" or otherwise wait for wall-clock time to pass

    @REQ-EA-550
    Scenario: An eight-day expiry is asserted without the test taking eight days
      Given a client built with "HttpApiTest.groups(AuthApi, [\"password\", \"session\"])" for a session configured to expire after 8 days
      When the test adjusts "TestClock" by "8 days" and then calls "client.session.current()"
      Then the call fails with "Unauthenticated"
      And the test completes without any real elapsed wait

  # BEH-EA-195 — spec/behaviors/25-testing-harness.md
  @BEH-EA-195
  Rule: Layer.mock for partial doubles

    @REQ-EA-551
    Scenario: A test overriding one method of a multi-method port uses Layer.mock
      Given a test that only needs to override "Mailer"'s "send" method
      When the test provides its double for "Mailer"
      Then it uses "Layer.mock" to override only "send"
      And it does not hand-write a full replacement implementation of "Mailer"'s interface

    @REQ-EA-552
    Scenario: Layer.mock is chosen over Mailer.layerMemory when a test needs no recording or inspection behavior
      Given a test that only asserts "send" was called with the expected arguments
      When the test does not need "Mailer.layerMemory"'s recording or inspection behavior
      Then the test uses "Layer.mock" instead of the full memory implementation

  # BEH-EA-196 — spec/behaviors/25-testing-harness.md
  @BEH-EA-196
  Rule: qadiTestLayer and subjectWith for authorization unit tests

    @REQ-EA-553
    Scenario: A policy-level unit test constructs its subject with subjectWith
      Given a test asserting a single policy's behavior in isolation
      When the test constructs the calling subject
      Then it builds that subject with "subjectWith"

    @REQ-EA-554
    Scenario: A policy-level unit test provides qadi's services via qadiTestLayer
      Given a test asserting a single policy's behavior in isolation
      When qadi's services are provided to the test
      Then they are provided via "qadiTestLayer" from "@qadi/testing"

    @REQ-EA-555
    Scenario: A policy-level unit test does not stand up the full HTTP pipeline
      Given a test whose only concern is a single policy's behavior
      When the test is composed
      Then it does not compose "TestAuth.layer", an HTTP client, or any server layer merely to exercise that policy

  # BEH-EA-197 — spec/behaviors/25-testing-harness.md
  @BEH-EA-197
  Rule: TestAuth.signInAs drives HTTP-level authorization tests

    @REQ-EA-556
    Scenario: An HTTP-level authorization test signs in through TestAuth.signInAs rather than fabricating a principal
      Given a test asserting that "RequirePermission" or "AuthorizedSubject" blocks or allows a real HTTP request
      When the test establishes its calling identity
      Then it uses "TestAuth.signInAs" rather than calling a handler function directly with a fabricated principal

    @REQ-EA-557
    Scenario: An HTTP-level authorization test runs against the whole AuthzLive/QadiLive pipeline
      Given a test asserting that "RequirePermission" correctly blocks or allows a request
      When the test is composed
      Then it merges "AuthzLive" and "QadiLive" alongside "TestAuth.layer" rather than substituting a stub for either

    @REQ-EA-558
    Scenario: A signed-in caller lacking the required role is blocked by the real RequirePermission middleware
      Given a caller signed in via "TestAuth.signInAs" with roles ["member"] only
      And qadi's evaluator would return a Deny decision for that caller against the admin-only endpoint's policy
      When the caller requests an endpoint gated by "RequirePermission" for the admin role
      Then the request fails with "Forbidden"

    @REQ-EA-559
    Scenario: Calling a handler function directly with a fabricated principal bypasses the middleware chain under test
      Given a test that calls a handler function directly with a fabricated principal instead of using "TestAuth.signInAs"
      When that approach is used
      Then it bypasses the "RequirePermission"/"AuthorizedSubject" middleware chain the test is meant to verify

  # BEH-EA-198 — spec/behaviors/25-testing-harness.md
  @BEH-EA-198
  Rule: runPluginContractTests checks manifest legality and migrations

    @REQ-EA-560
    Scenario: runPluginContractTests checks manifest legality across every supplied option combination
      Given a plugin "invite" run through "runPluginContractTests" with option combinations "{}" and "{ ttl: \"1 hour\" }"
      When the contract test suite runs
      Then it asserts the plugin's manifest is legal under each supplied option combination

    @REQ-EA-561
    Scenario: runPluginContractTests asserts the plugin's group ids are unique
      Given a plugin "invite" run through "runPluginContractTests"
      When the contract test suite runs
      Then it asserts "invite"'s contract group ids are unique

    @REQ-EA-562
    Scenario: runPluginContractTests asserts the plugin's tables carry its own prefix
      Given a plugin "invite" run through "runPluginContractTests"
      When the contract test suite runs
      Then it asserts every table "invite" declares carries the "invite_" prefix

    @REQ-EA-563
    Scenario: runPluginContractTests asserts the plugin's migrations apply deterministically
      Given a plugin "invite" run through "runPluginContractTests"
      When the contract test suite applies "invite"'s migrations twice, independently
      Then it asserts both runs apply the migrations identically

    @REQ-EA-564
    Scenario: A missing declared host dependency fails contract testing with E_PLUGIN_MISSING_DEP
      Given a plugin "invite" run through "runPluginContractTests(invite, { options: [{}, { ttl: \"1 hour\" }], host: [password()] })" with its declared host dependency omitted from "host"
      When the contract test suite runs
      Then it fails with "E_PLUGIN_MISSING_DEP"

    @REQ-EA-565
    Scenario: A third-party plugin author runs runPluginContractTests without awthaq's own source
      Given a third-party plugin "invite" built outside the awthaq repository
      When its author runs "runPluginContractTests(invite, { options, host })"
      Then the suite runs to completion without needing awthaq's own source code

  # BEH-EA-199 — spec/behaviors/25-testing-harness.md
  @BEH-EA-199
  Rule: Redaction and contract-hash stability

    @REQ-EA-566
    Scenario: runPluginContractTests fails when a Redacted value reaches a span or event the plugin emits
      Given a plugin whose "AfterSignUp" tap emits a span or event containing a "Redacted"-wrapped value
      When "runPluginContractTests" runs against that plugin
      Then the contract test fails
      And the failure is not left to a code review to catch

    @REQ-EA-567
    Scenario: runPluginContractTests fails when changing the plugin's options changes its contract's hash
      Given a plugin whose contract hash is computed once with its default options and again with a different "minLength" option
      When "runPluginContractTests" compares the two contract hashes
      Then the contract test fails because the two hashes differ

    @REQ-EA-568
    Scenario: runPluginContractTests passes when no Redacted value leaks and the contract hash is stable across options
      Given a plugin that emits no "Redacted" value in any span or event and whose contract hash is identical across every supplied option combination
      When "runPluginContractTests" runs
      Then both checks pass

  # BEH-EA-200 — spec/behaviors/25-testing-harness.md
  @BEH-EA-200
  Rule: Veto only in veto points, and observer isolation

    @REQ-EA-569
    Scenario: runPluginContractTests asserts an observe-point tap cannot abort the operation it observes
      Given a "kind: \"observe\"" hook point "AfterSignUp" tapped by "Welcome"
      When "runPluginContractTests" exercises "Welcome"'s tap attempting to abort the sign-up operation
      Then it asserts the sign-up operation is not aborted

    @REQ-EA-570
    Scenario: runPluginContractTests asserts a throwing observer's failure does not propagate to the operation it observes
      Given the "Welcome" tap on "AfterSignUp" fails because its "Mailer" is unavailable
      When "runPluginContractTests" runs against that plugin
      Then it asserts the sign-up operation still succeeds despite "Welcome"'s failure

    @REQ-EA-571
    Scenario: runPluginContractTests asserts only a veto-point tap may abort or amend an operation
      Given a "kind: \"veto\"" hook point "BeforeSignUp" tapped by "CompanyEmail"
      When "runPluginContractTests" exercises "CompanyEmail"'s tap aborting the operation
      Then it asserts the abort is accepted, because "BeforeSignUp" is a veto point

    @REQ-EA-572
    Scenario: A plugin whose observe-point tap aborts its operation fails the contract test
      Given a plugin whose "kind: \"observe\"" hook tap attempts to abort the operation it observes
      When "runPluginContractTests" runs against that plugin
      Then the contract test fails
