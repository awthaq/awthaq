# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# BCR-010/P20a: authored against the shipped `@awthaq/two-factor` (ADR-EA-020). Every scenario
# drives the real `Password` plugin as the first factor, the real `TwoFactor` plugin with both
# gates, the real in-memory stores, the real `Encryption` port and a real `RateLimiter`, at the
# service level (the wire contract is covered by packages/two-factor/test/AuthHttp.test.ts).
# TOTP codes are computed on the same clock the services read, so a scenario states "a new time
# step begins" instead of sleeping.

@mfa-passwordless @two-factor
Feature: Two-Factor Authentication

  # BEH-EA-260 — spec/behaviors/31-two-factor.md; see also ADR-EA-020
  @BEH-EA-260
  Rule: TOTP is RFC 6238, computed by a pure module checked against the published vectors

    @REQ-EA-1025
    Scenario Outline: The HMAC-SHA-1 HOTP reproduces every RFC 4226 Appendix D value
      Given the RFC 4226 Appendix D key "12345678901234567890"
      When the six-digit HOTP is computed for counter <counter>
      Then the code is "<code>"

      Examples:
        | counter | code   |
        | 0       | 755224 |
        | 1       | 287082 |
        | 2       | 359152 |
        | 3       | 969429 |
        | 4       | 338314 |
        | 5       | 254676 |
        | 6       | 287922 |
        | 7       | 162583 |
        | 8       | 399871 |
        | 9       | 520489 |

    @REQ-EA-1026
    Scenario Outline: The TOTP reproduces every RFC 6238 Appendix B SHA-1 value
      Given the RFC 4226 Appendix D key "12345678901234567890"
      When the eight-digit TOTP is computed at Unix time <time>
      Then the code is "<code>"

      Examples:
        | time        | code     |
        | 59          | 94287082 |
        | 1111111109  | 07081804 |
        | 1111111111  | 14050471 |
        | 1234567890  | 89005924 |
        | 2000000000  | 69279037 |
        | 20000000000 | 65353130 |

    @REQ-EA-1027
    Scenario Outline: Verification accepts one step of drift either side of the current step and refuses two
      Given the RFC 4226 Appendix D key "12345678901234567890"
      And the current time is Unix time 1111111109
      When the code of the step <offset> steps from the current one is presented for verification
      Then the code is <outcome>

      Examples:
        | offset | outcome  |
        | -2     | refused  |
        | -1     | accepted |
        | 0      | accepted |
        | 1      | accepted |
        | 2      | refused  |

    @REQ-EA-1028
    Scenario: A step at or before the last accepted one is refused as a replay
      Given the RFC 4226 Appendix D key "12345678901234567890"
      And the current time is Unix time 1111111109
      And the last accepted step is the current step
      When the code of the step 0 steps from the current one is presented for verification
      Then the code is refused
      And the code of the step -1 steps from the current one is refused
      And the code of the step 1 steps from the current one is accepted

    @REQ-EA-1029
    Scenario Outline: A malformed code is no match rather than an error
      Given the RFC 4226 Appendix D key "12345678901234567890"
      And the current time is Unix time 1111111109
      When the code "<code>" is presented for verification
      Then the code is refused
      And no error was raised

      Examples:
        | code    |
        |         |
        | 12345   |
        | 1234567 |
        | abcdef  |
        | 12345a  |
        | 12 456  |

    @REQ-EA-1030
    Scenario: An enrolment secret is 160 random bits from the ambient Crypto service
      Given a registered user "alice" with a verified mailbox
      And a registered user "bob" with a verified mailbox
      When "alice" begins enrolling a second factor
      And "bob" begins enrolling a second factor
      Then the secret shown to "alice" decodes from base32 to 20 bytes
      And the secrets shown to "alice" and "bob" differ

    @REQ-EA-1031
    Scenario: base32 is the unpadded RFC 4648 alphabet and decoding tolerates case, spaces and hyphens
      Given the RFC 4226 Appendix D key "12345678901234567890"
      Then its base32 encoding is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
      And decoding "gezd gnbv-GY3T QOJQ gezdgnbvgy3tqojq" yields that key
      And decoding a text containing the character "1" yields nothing

    @REQ-EA-1032
    Scenario: The otpauth URI follows the Key Uri Format
      Given a registered user "alice" with a verified mailbox
      When "alice" begins enrolling a second factor
      Then the URI shown to "alice" is an "otpauth://totp/" link carrying her secret, the issuer, "period=30" and "digits=6"

  # BEH-EA-261 — spec/behaviors/31-two-factor.md; see also ADR-EA-020, BEH-EA-024
  @BEH-EA-261
  Rule: A sign-in with a confirmed second factor is diverted, and no session exists until it passes

    @REQ-EA-1033
    Scenario: A first factor for an enrolled user is diverted to TwoFactorRequired and mints no session
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And the number of sessions issued so far is noted
      When "alice" signs in with her password
      Then the sign-in fails with "TwoFactorRequired" carrying her user id and a challenge id
      And no session was issued by the sign-in

    @REQ-EA-1034
    Scenario: A pending, unconfirmed secret never diverts a sign-in
      Given a registered user "alice" with a verified mailbox
      And "alice" has begun enrolling but not confirmed
      When "alice" signs in with her password
      Then the sign-in succeeds with a session for "alice"

    @REQ-EA-1035
    Scenario: A user without a second factor signs in exactly as before
      Given a registered user "alice" with a verified mailbox
      When "alice" signs in with her password
      Then the sign-in succeeds with a session for "alice"

    @REQ-EA-1036
    Scenario Outline: Every first-factor strategy that consults BeforeSessionIssue is diverted
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When the "<strategy>" first factor consults BeforeSessionIssue for "alice"
      Then the hook diverts to "TwoFactorRequired" carrying her user id and a challenge id

      Examples:
        | strategy   |
        | password   |
        | oauth      |
        | passkey    |
        | magic-link |
        | email-otp  |

    @REQ-EA-1037
    Scenario: A strategy named in bypassStrategies is the only way a first factor skips the divert
      Given the application declares "passkey" in bypassStrategies
      And a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When the "passkey" first factor consults BeforeSessionIssue for "alice"
      Then the hook lets the sign-in continue
      And the "password" first factor consulting BeforeSessionIssue for "alice" is still diverted

    @REQ-EA-1038
    Scenario: The session finally minted records how both factors were proven
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      And a new time step begins
      When "alice" presents her current authenticator code with her challenge
      Then the second factor issues a session for "alice" recording "pwd", "otp" and "mfa"

    # @skip: a compile-time property (composing TwoFactor without a gate does not type-check); the
    # gate is a type-level marker with no runtime effect to observe. Covered by
    # packages/two-factor/test/TwoFactor.types.test.ts (pluginRequiresTheSessionGate,
    # pluginRequiresAResetGuard, sessionGateProvidesItsMarker) which the typecheck compiles
    @skip
    @REQ-EA-1039
    Scenario: Composing the plugin without a gate is a compile error
      Given a composition of "TwoFactor" that omits "sessionGate" or "credentialResetGate"
      When the composition is type-checked
      Then it fails to compile because a required marker service is missing

  # BEH-EA-262 — spec/behaviors/31-two-factor.md; see also BEH-EA-059, ADR-EA-020
  @BEH-EA-262
  Rule: The challenge is a single-use Verification row, consumed before the code is checked

    @REQ-EA-1040
    Scenario: A second divert supersedes the earlier live challenge
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When "alice" is diverted twice in a row
      Then her first challenge is refused as an "InvalidTwoFactorCode"
      And her second challenge is still spendable

    @REQ-EA-1041
    Scenario: The challenge is a Verification row under the account's own identifier
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      Then her challenge identifier is "two-factor-challenge:" followed by her user id

    @REQ-EA-1042
    Scenario Outline: The challenge lives ten minutes
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      When <minutes> minutes pass
      Then her challenge is <state>

      Examples:
        | minutes | state                                 |
        | 9       | spendable                             |
        | 10      | refused as an "InvalidTwoFactorCode"  |

    @REQ-EA-1043
    Scenario: A replayed challenge is refused and published as auth.token.replay
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      And a new time step begins
      And "alice" presents her current authenticator code with her challenge
      When the same challenge and code are presented again
      Then the answer is an "InvalidTwoFactorCode"
      And an "auth.token.replay" event was published for the replay

    @REQ-EA-1044
    Scenario: The challenge is consumed before the code is checked
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      When "alice" presents the wrong code "000000" with her challenge
      Then the answer is an "InvalidTwoFactorCode" carrying a fresh challenge
      And the challenge she presented is refused if she presents it again

    @REQ-EA-1045
    Scenario: A challenge minted for one user cannot be spent as another's
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a registered user "bob" with a verified mailbox
      And "bob" has enrolled a second factor
      When "alice"'s challenge value is presented under "bob"'s challenge identifier
      Then the answer is an "InvalidTwoFactorCode"
      And "alice"'s own challenge is still spendable

    @REQ-EA-1046
    Scenario: A wrong code re-issues a fresh challenge until the attempts are spent
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      When "alice" presents the wrong code "000000" three times, each time on the challenge the previous answer carried
      Then the first two answers carry a fresh challenge that was never seen before
      And the third answer carries no challenge

    @REQ-EA-1047
    Scenario Outline: Every failure is the one InvalidTwoFactorCode
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When a second-factor presentation fails because "<cause>"
      Then the answer is an "InvalidTwoFactorCode"

      Examples:
        | cause                                     |
        | the challenge is malformed                |
        | the challenge is unknown                  |
        | the challenge has expired                 |
        | the challenge was already spent           |
        | the challenge belongs to another user     |
        | the code is wrong                         |
        | the factor was disabled since the divert  |

    @REQ-EA-1048
    Scenario: A user suspended between the first factor and the second gets no session
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      And "alice" is suspended
      And a new time step begins
      And the number of sessions issued so far is noted
      When "alice" presents her current authenticator code with her challenge
      Then the answer is "UserSuspended"
      And no session was issued by the second factor

  # BEH-EA-263 — spec/behaviors/31-two-factor.md; see also ADR-EA-020
  @BEH-EA-263
  Rule: Enrolling, disabling and regenerating need a fresh session, and the secret is encrypted at rest

    @REQ-EA-1049
    Scenario: Enrolling needs a session authenticated within the last ten minutes
      Given a registered user "alice" with a verified mailbox
      And 11 minutes pass
      When "alice" begins enrolling a second factor
      Then the answer is "TwoFactorReauthRequired" naming a maximum age of 600 seconds

    @REQ-EA-1050
    Scenario: A pending secret is not an active factor until a valid code confirms it
      Given a registered user "alice" with a verified mailbox
      When "alice" begins enrolling a second factor
      Then "alice" has no second factor enabled
      And confirming with the code "000000" is refused as an "InvalidTwoFactorCode"
      And "alice" still has no second factor enabled
      When "alice" confirms with her current authenticator code
      Then "alice" has a second factor enabled

    @REQ-EA-1051
    Scenario: Enrolling an already-confirmed account fails
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When "alice" begins enrolling a second factor
      Then the answer is "TwoFactorAlreadyEnabled"

    @REQ-EA-1052
    Scenario: The secret is stored only as an Encryption envelope bound to its owner
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a registered user "bob" with a verified mailbox
      And "bob" has enrolled a second factor
      Then the stored secret row of "alice" does not contain her base32 secret
      And "alice"'s envelope decrypts to her secret under the additional data "two_factor_secret:" followed by her user id
      And "alice"'s envelope moved to "bob"'s row fails authentication

    @REQ-EA-1053
    Scenario: The secret appears in no published event, audit row or data export
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When the audit log and the data export of "alice" are read
      Then neither contains her base32 secret, a recovery code or a recovery-code hash
      And the export says a second factor is enabled with 10 recovery codes remaining

    @REQ-EA-1054
    Scenario Outline: Disabling and regenerating need a valid TOTP or recovery code
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When "alice" attempts to <operation> with the code "000000"
      Then the answer is an "InvalidTwoFactorCode"

      Examples:
        | operation                     |
        | disable the second factor     |
        | regenerate her recovery codes |

    @REQ-EA-1055
    Scenario: Disabling with a valid code removes the factor and stops the divert
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a new time step begins
      When "alice" disables the second factor with her current authenticator code
      Then "alice" has no second factor enabled
      And "alice" signs in with her password without a divert
      And disabling again is refused as "TwoFactorNotEnabled"

    @REQ-EA-1056
    Scenario: A stale session cannot disable or regenerate
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And 11 minutes pass
      And a new time step begins
      When "alice" disables the second factor with her current authenticator code
      Then the answer is "TwoFactorReauthRequired" naming a maximum age of 600 seconds

    @REQ-EA-1057
    Scenario: Erasing the account removes the secret and every recovery code
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a registered user "bob" with a verified mailbox
      And "bob" has enrolled a second factor
      When "alice"'s account is erased
      Then no secret row and no recovery code remains for "alice"
      And "bob"'s secret and recovery codes are untouched

  # BEH-EA-264 — spec/behaviors/31-two-factor.md
  @BEH-EA-264
  Rule: Recovery codes are hashed, single-use, shown once and replaced atomically

    @REQ-EA-1058
    Scenario: Confirming mints ten recovery codes of ten characters from an unambiguous alphabet
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      Then "alice" was shown 10 recovery codes of 10 characters each, grouped as "ABCDE-FGHJK"
      And the recovery codes use only the 32 unambiguous symbols

    @REQ-EA-1059
    Scenario: Only a password hash of each recovery code is stored
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      Then the stored recovery codes of "alice" are argon2id hashes containing none of the codes she was shown

    @REQ-EA-1060
    Scenario: A recovery code signs in exactly once and is counted down and audited
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      When "alice" presents her first recovery code in lower case with her challenge
      Then the second factor issues a session for "alice" recording "pwd", "otp" and "mfa"
      And "alice" has 9 recovery codes remaining
      And an "auth.twoFactor.recoveryCodeUsed" event was published with 9 remaining
      When "alice" is diverted again and presents the same recovery code
      Then the answer is an "InvalidTwoFactorCode"

    @REQ-EA-1061
    Scenario: A recovery code is spent exactly once under concurrent presentation
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When her first recovery code is presented twice concurrently to the second factor
      Then exactly one presentation is accepted
      And the other is an "InvalidTwoFactorCode"

    @REQ-EA-1062
    Scenario: Regenerating replaces the whole set and the old set stops working
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When "alice" regenerates her recovery codes with her second recovery code
      Then she is shown 10 new recovery codes and has 10 remaining
      And an "auth.twoFactor.recoveryCodesRegenerated" event was published
      And a diverted sign-in presenting one of her old recovery codes is an "InvalidTwoFactorCode"
      And a diverted sign-in presenting one of her new recovery codes succeeds

    @REQ-EA-1063
    Scenario: A failure part-way through a replacement leaves the old set intact
      Given a SQL-backed recovery-code store holding two unused codes for a user
      When replacing the set fails while inserting the first new code
      Then the user still holds exactly the same two unused codes

    @REQ-EA-1064
    Scenario: The remaining count is readable
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      Then the status of "alice" reports a second factor with 10 recovery codes remaining

    # @skip: "refused without running a password hash" is an internal-mechanism claim about work not
    # done; a scenario cannot observe an absent hash computation through the service seam. Covered by
    # packages/two-factor/test/RecoveryCodes.test.ts "rejects a string that cannot be a code without
    # a hash being computed"
    @skip
    @REQ-EA-1065
    Scenario: A string that cannot be a recovery code is refused without a password hash being computed
      Given a registered user "alice" with a verified mailbox
      When a string that cannot be a recovery code is presented
      Then no password hash is computed

  # BEH-EA-265 — spec/behaviors/31-two-factor.md; see also RFC 6238 section 5.2
  @BEH-EA-265
  Rule: A TOTP step is accepted at most once, even concurrently

    @REQ-EA-1066
    Scenario: A step's code cannot be replayed on a later sign-in
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a new time step begins
      And "alice" holds a challenge from a diverted password sign-in
      And "alice" presents her current authenticator code with her challenge
      When "alice" is diverted again and presents the same code
      Then the answer is an "InvalidTwoFactorCode"

    @REQ-EA-1067
    Scenario: Of two concurrent verifications of one code exactly one wins
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a new time step begins
      When her current authenticator code is presented twice concurrently to the second factor
      Then exactly one presentation is accepted
      And the other is an "InvalidTwoFactorCode"

    @REQ-EA-1068
    Scenario: The code that confirms enrolment cannot be replayed at sign-in
      Given a registered user "alice" with a verified mailbox
      And "alice" has begun enrolling but not confirmed
      And "alice" confirms with her current authenticator code
      And "alice" holds a challenge from a diverted password sign-in
      When "alice" presents that same confirming code with her challenge
      Then the answer is an "InvalidTwoFactorCode"

    @REQ-EA-1069
    Scenario: A pending secret never overwrites a confirmed one
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      When a pending secret is stored for "alice" directly in the secrets store
      Then the store refuses it and "alice"'s confirmed secret is unchanged

  # BEH-EA-266 — spec/behaviors/31-two-factor.md; see also ADR-EA-020
  @BEH-EA-266
  Rule: One failure budget per account locks the second factor, and every outcome is audited

    @REQ-EA-1070
    Scenario: Five failures across TOTP and recovery codes lock the second factor even for the right code
      Given the application enforces its rate limits
      And a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And a new time step begins
      When "alice" fails 2 TOTP presentations and 3 recovery-code presentations, each on a fresh challenge
      Then an "auth.twoFactor.locked" event was published exactly once for "alice"
      And presenting her correct current authenticator code is refused as "SecondFactorLocked" with a positive retry delay
      And still only one "auth.twoFactor.locked" event was published

    @REQ-EA-1071
    Scenario: The budget is checked before the code is evaluated and a locked attempt spends no recovery code
      Given the application enforces its rate limits
      And a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" has failed 5 presentations
      When "alice" presents her first recovery code
      Then the answer is "SecondFactorLocked"
      And "alice" still has 10 recovery codes remaining

    @REQ-EA-1072
    Scenario: The lock lifts when the fifteen-minute window passes
      Given the application enforces its rate limits
      And a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" has failed 5 presentations
      And 16 minutes pass
      And a new time step begins
      When "alice" presents her correct current authenticator code on a fresh challenge
      Then the second factor issues a session for "alice" recording "pwd", "otp" and "mfa"

    @REQ-EA-1073
    Scenario: A success does not reset the budget
      Given the application enforces its rate limits
      And a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" has failed 4 presentations
      And a new time step begins
      And "alice" presents her correct current authenticator code on a fresh challenge
      When "alice" fails 1 more presentation
      And a new time step begins
      Then presenting her correct current authenticator code is refused as "SecondFactorLocked"

    @REQ-EA-1074
    Scenario: Enrolment, use of a factor and every failure are audited with identifiers only
      Given a registered user "alice" with a verified mailbox
      And "alice" has enrolled a second factor
      And "alice" holds a challenge from a diverted password sign-in
      And "alice" presents the wrong code "000000" with her challenge
      And a new time step begins
      And "alice" holds a challenge from a diverted password sign-in
      And "alice" presents her current authenticator code with her challenge
      When "alice" disables the second factor with her recovery code
      Then the audit log holds "auth.twoFactor.enabled", "auth.twoFactor.challengeFailed", "auth.twoFactor.verified" and "auth.twoFactor.disabled" events for "alice"
      And none of those events carries a code, a secret or a hash
