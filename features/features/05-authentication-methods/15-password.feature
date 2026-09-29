# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@authentication-methods @password
Feature: Password Authentication

  # BEH-EA-113 — spec/behaviors/15-password.md
  @BEH-EA-113
  Rule: Sign-up issues a pending user and a verification mail

    @REQ-EA-304
    Scenario: Sign-up creates the user and the initial session in one transaction
      Given no user exists with email "alice@example.com"
      When "alice@example.com" signs up with a password
      Then the User row and the initial session are both created under one transaction

    # TIR-005: the atomicity half of the claim above, observable only over a real transaction (SQLite).
    @REQ-EA-692
    Scenario: A failure while issuing the initial session leaves no User row behind
      Given no user exists with email "alice@example.com"
      And the initial session cannot be issued
      When "alice@example.com" signs up with a password
      Then the sign-up fails with a server error
      And no User row exists for "alice@example.com"

    @REQ-EA-305
    Scenario: Sign-up dispatches the verification mail without waiting for delivery
      Given a sign-up request for "alice@example.com"
      When "password.signUp" handles the request
      Then the caller receives a "SessionView" without the response waiting on the verification mail's delivery
      And the mail is dispatched as a detached, fire-and-forget effect

    # @skip: a wall-clock timing side-channel is not deterministically assertable in CI; the
    # "does not wait on mail delivery" half is proven with a never-resolving mailer by
    # packages/password/test/Password.test.ts (TSS-001/TSS-002 tests), and the account-existence
    # half is deliberately open under the default signUpEnumeration "reveal" (TMS-005, ADR-EA-018)
    # — only "conceal" hides it.
    @skip
    @REQ-EA-306
    Scenario: Sign-up response time does not reveal whether the email address already had an account
      Given a slow-responding mail provider
      And two sign-up requests, one for an email with no existing account and one for an email that already has one
      When both requests are handled
      Then neither response's timing varies with the mail provider's latency
      And the response timing does not leak which email already had an account

  # BEH-EA-114 — spec/behaviors/15-password.md
  @BEH-EA-114
  Rule: Uniform InvalidCredentials on sign-in

    @REQ-EA-307
    Scenario Outline: Sign-in fails with the same InvalidCredentials error regardless of the underlying reason
      Given a sign-in attempt where "<reason>"
      When "password.signIn" is called
      Then the response is "401 Unauthenticated" with the "InvalidCredentials" error

      Examples:
        | reason                                          |
        | the email is unknown                            |
        | the password is wrong                           |
        | the account has no password credential at all   |

    @REQ-EA-308
    Scenario: The three underlying failure reasons produce responses indistinguishable from one another
      Given a sign-in attempt for an unknown email, one for a known email with a wrong password, and one for an account with no password credential
      When each is handled
      Then all three responses have the identical status and the identical body
      And none of them reveals which of the three reasons applied

    # @skip: wall-clock latency is not deterministically assertable in CI; the mechanism that
    # equalises the three failure reasons (the calibrated timing floor) is covered by the
    # "Password signIn timing floor (TSS-006)" suite in packages/password/test/Password.test.ts.
    @skip
    @REQ-EA-309
    Scenario: Response latency does not vary across the three failure reasons
      Given the same three sign-in attempts, differing only in which of the three reasons applies
      When each is handled
      Then the response latency does not vary in a way that would let an attacker distinguish the reasons by timing

  # BEH-EA-115 — spec/behaviors/15-password.md; see also ADR-EA-010.
  @BEH-EA-115
  Rule: PasswordHasher is a port the plugin never provides

    @REQ-EA-310
    Scenario: The application supplies the default Argon2id hasher and Password composes against it
      Given an application composing "Password"
      When the application provides "PasswordHasher.layerArgon2id"
      Then "Password" hashes and verifies passwords using the provided "PasswordHasher"

    @REQ-EA-311
    Scenario: The application swaps in a WebCrypto-only hasher without changing the Password plugin
      Given an application composing "Password" for a WebCrypto-only runtime
      When the application provides "PasswordHasher.layerScrypt" in place of the default
      Then "Password" hashes and verifies passwords using "PasswordHasher.layerScrypt"
      And no change is made to "Password"'s own code to accept the substitution

    # @skip: "the composition remains incomplete" is a compile-time property (an unsatisfied
    # Layer requirement is a type error where it is composed, not a runtime outcome), so no
    # runtime step can express it; covered by the type-level test "BEH-EA-115: Password.layer
    # requires a PasswordHasher" in packages/password/test/Password.test.ts.
    @skip
    @REQ-EA-312
    Scenario: Password bundles no hashing implementation of its own
      Given an application composing "Password" with no "PasswordHasher" Layer provided
      When the application's Layer is composed
      Then the composition remains incomplete, since "Password" contributes no default "PasswordHasher" to satisfy its own requirement

  # BEH-EA-116 — spec/behaviors/15-password.md
  @BEH-EA-116
  Rule: Rehash on login

    # PHS-005: observed through PasswordWorld's credential-hash read handle (no endpoint returns
    # a stored hash); the domain-level twin is packages/password/test/Password.test.ts
    # "BEH-EA-116: signIn against a hash stored under outdated parameters rehashes ...".
    @REQ-EA-313
    Scenario: A sign-in against a hash stored under outdated parameters triggers a rehash with current parameters
      Given a user "alice" whose stored password hash was computed under previously configured "PasswordHasher" parameters
      And "PasswordHasher"'s currently configured parameters are stronger than those under which the hash was stored
      When "alice" signs in successfully with her password
      Then the password is rehashed with the current parameters within the same request
      And the stored hash is replaced with the new one

    @REQ-EA-314
    Scenario: A sign-in against a hash already matching current parameters does not trigger a rehash
      Given a user "bob" whose stored password hash already matches "PasswordHasher"'s currently configured parameters
      When "bob" signs in successfully with his password
      Then the stored hash is not replaced

    @REQ-EA-315
    Scenario: The rehash occurs synchronously within the sign-in request, not as a deferred job
      Given a user "alice" whose stored hash's parameters differ from the currently configured parameters
      When "alice" signs in successfully
      Then the rehash completes within the same request that serves the sign-in response
      And no separate background migration job is relied upon to update the stored hash

  # BEH-EA-117 — spec/behaviors/15-password.md
  @BEH-EA-117
  Rule: Reset revokes other sessions in the same transaction

    @REQ-EA-316
    Scenario: password.requestReset responds identically for a known and an unknown email
      Given an email "alice@example.com" with an existing account and an email "nobody@example.com" with no account
      When each requests a password reset
      Then both responses are "202 Accepted" with identical bodies

    @REQ-EA-317
    Scenario: Confirming a reset consumes the token, sets the new password, and revokes other sessions in one transaction
      Given a live password-reset token for "alice" and an existing session "s1" for "alice"
      When "alice" confirms the reset with that token and a new password
      Then the token is consumed
      And the new password is set
      And session "s1" is revoked
      And all three effects commit under one transaction

    # TIR-005: the atomicity half of REQ-EA-317, over a real SQLite transaction with a fault injected
    # after the credential hash update.
    @REQ-EA-693
    Scenario: A failure after the credential hash update rolls back the token, the new password and the session revocation together
      Given a live password-reset token for "alice" and an existing session "s1" for "alice"
      And the reset fails after the credential hash update
      When "alice" confirms the reset with that token and a new password
      Then the request fails with a server error
      And the old password still signs in
      And session "s1" is still valid
      And the reset token is still redeemable

    @REQ-EA-318
    Scenario: A session obtained before the reset does not survive it
      Given an attacker holding a session "s-attacker" for "alice" obtained before she resets her password
      When "alice" confirms a password reset
      Then session "s-attacker" is no longer valid

  # BEH-EA-118 — spec/behaviors/15-password.md
  @BEH-EA-118
  Rule: Verification and replay

    @REQ-EA-319
    Scenario: Confirming an already-consumed verification token fails with TokenConsumed
      Given a verification token that has already been consumed
      When the same token is presented to "verification.confirm" again
      Then the request fails with "410 TokenConsumed"

    @REQ-EA-320
    Scenario: Replaying an already-consumed verification token publishes auth.token.replay
      Given a verification token that has already been consumed
      When the same token is presented to "verification.confirm" again
      Then an "auth.token.replay" event is published

    @REQ-EA-321
    Scenario: A replayed verification token never silently succeeds or silently no-ops
      Given a verification token that has already been consumed
      When the same token is presented to "verification.confirm" again
      Then the replayed action is not performed a second time
      And the caller receives the "410 TokenConsumed" failure rather than an apparent success

  # BEH-EA-119 — spec/behaviors/15-password.md
  @BEH-EA-119
  Rule: Breach-check is fail-open by default, fail-closed by config

    @REQ-EA-322
    Scenario: Sign-up proceeds by default when the breach-database provider is unreachable
      Given "password({ breachCheck: true })" with no "onUnavailable" override
      And the breach-database provider is unreachable
      When a user signs up with a password
      Then sign-up proceeds

    @REQ-EA-323
    Scenario: Sign-up is blocked when the application explicitly configures fail-closed
      Given "password({ breachCheck: { onUnavailable: \"reject\" } })"
      And the breach-database provider is unreachable
      When a user signs up with a password
      Then sign-up is rejected

    @REQ-EA-324
    Scenario: Every failure mode of the breach-check provider is treated uniformly as unavailable under the default posture
      Given "password({ breachCheck: true })" with no "onUnavailable" override
      And the breach-database provider fails by timeout in one attempt, by a 5xx response in another, and with a malformed response in a third
      When a user signs up with a password in each case
      Then sign-up proceeds in all three cases, each treated as "unavailable" rather than handled inconsistently by cause

    # CSD-009: under the default posture "unavailable" and "not breached" both let sign-up through,
    # so REQ-EA-324 cannot tell them apart; fail-closed can.
    @REQ-EA-694
    Scenario Outline: Every failure mode of the breach-check provider is rejected under the fail-closed configuration
      Given "password({ breachCheck: { onUnavailable: \"reject\" } })"
      And the breach-database provider fails by <failure>
      When a user signs up with a password
      Then sign-up is rejected

      Examples:
        | failure   |
        | timeout   |
        | 5xx       |
        | malformed |

  # BEH-EA-120 — spec/behaviors/15-password.md
  @BEH-EA-120
  Rule: Password policy is configuration, not a plugin variant

    @REQ-EA-325
    Scenario: minLength and breachCheck are overridden via Password.config, not by choosing a different plugin
      Given an application composing the single "Password" plugin
      When it provides "Password.config({ minLength: 16 })"
      Then the tightened policy takes effect without installing any different plugin class

    # @skip: a structural claim about object identity (the plugin class's own `contract`, `tables`
    # and `migrations` statics are constants a Layer cannot touch), so a runtime scenario could
    # only assert a tautology; the behavior that IS runtime (the override takes effect) is
    # REQ-EA-325, and `Password.config` is typed `Partial<PasswordConfigShape>`, which carries
    # no contract or migration field to override.
    @skip
    @REQ-EA-326
    Scenario: Overriding minLength does not change Password's contract, table set, or migrations
      Given "Password.config({ minLength: 16 })" is provided in place of the default "minLength: 8"
      When "Password"'s contract, table set, and migrations are inspected
      Then its contract is unchanged
      And its table set is unchanged
      And its migrations are unchanged

    @REQ-EA-327
    Scenario: A sign-up whose password appears in a known breach fails with WeakPassword
      Given "password({ breachCheck: true, minLength: 12 })"
      When a user signs up with a password that appears in a known breach
      Then sign-up fails with "422 WeakPassword"
      And the failure carries hints including "appears in known breaches"
