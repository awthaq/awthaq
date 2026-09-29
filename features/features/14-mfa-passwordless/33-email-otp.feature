# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# BCR-010/P20a: authored against the shipped `EmailOtp` plugin of `@awthaq/magic-link` and the
# numeric-value and attempt-budget support it needs in `Verification`. Same composition as
# 32-magic-link.feature: real plugins over in-memory stores with the real `@awthaq/two-factor`
# gates; the recipient is played from the captured mail, and a code is never read from the store.

@passwordless @email-otp
Feature: Email OTP

  # BEH-EA-271 — spec/behaviors/33-email-otp.md; see also SOS-004, BCR-005
  @BEH-EA-271
  Rule: A short numeric code is minted inside Verification and carries an attempt budget

    @REQ-EA-1099
    Scenario Outline: Verification mints a numeric value of the requested width itself
      When Verification issues a numeric value of <digits> digits with an attempt budget of 3
      Then the value is exactly <digits> decimal digits

      Examples:
        | digits |
        | 4      |
        | 6      |
        | 10     |

    @REQ-EA-1100
    Scenario Outline: A width outside 4 to 10 digits is refused as a configuration defect
      When Verification is asked for a numeric value of <digits> digits
      Then the request is refused as a defect

      Examples:
        | digits |
        | 3      |
        | 11     |

    # @skip: a statistical property of the digit draw (rejection sampling); covered by
    # packages/core/test/Verification.test.ts "BCR-005: numeric digits are drawn uniformly"
    @skip
    @REQ-EA-1101
    Scenario: Digits are drawn uniformly from the crypto source
      When many numeric values are minted
      Then every digit occurs about equally often

    # @skip: compile-time property — `Verification.issue`'s input type has no field through which a
    # caller could choose the value of a numeric row (packages/core/src/Verification.ts, IssueInput),
    # so there is nothing to observe at runtime.
    @skip
    @REQ-EA-1102
    Scenario: A caller-chosen string is never accepted as a numeric value
      When a caller tries to supply its own numeric value
      Then the input is rejected by the type

    @REQ-EA-1103
    Scenario: A code with an attempt budget of 3 is burned by 3 wrong presentations
      Given a numeric code with an attempt budget of 3 under the identifier "email-otp:budget@example.com"
      When 3 wrong values are presented under "email-otp:budget@example.com"
      Then the right value no longer works under "email-otp:budget@example.com"

    @REQ-EA-1104
    Scenario: Fewer wrong presentations than the budget leave the code usable
      Given a numeric code with an attempt budget of 3 under the identifier "email-otp:budget@example.com"
      When 2 wrong values are presented under "email-otp:budget@example.com"
      Then the right value still works under "email-otp:budget@example.com"

    @REQ-EA-1105
    Scenario: A value with no attempt budget is never burned by wrong presentations
      Given a value with no attempt budget under the identifier "verify-email:plain"
      When 5 wrong values are presented under "verify-email:plain"
      Then the right value still works under "verify-email:plain"

  # BEH-EA-272 — spec/behaviors/33-email-otp.md; see also BEH-EA-064, BEH-EA-063
  @BEH-EA-272
  Rule: Requesting a code answers 202 for every address, inside a resend window

    @REQ-EA-1106
    Scenario: A known and an unknown address get the identical 202
      Given a user "ada@example.com"
      When "ada@example.com" and "nobody@example.com" each request a code over HTTP
      Then both responses are "202" with the same empty body

    @REQ-EA-1107
    Scenario: The mail is the email-otp template with a redacted six-digit code and its expiry
      When "ada@example.com" requests a code
      Then the "email-otp" mail to "ada@example.com" carries a redacted six-digit code and an expiry

    @REQ-EA-1108
    Scenario: With sign-up off an unknown address is answered like any other and not mailed
      Given the application disallows sign-up through email codes
      And a user "ada@example.com"
      When "ada@example.com" and "nobody@example.com" each request a code
      Then only "ada@example.com" was mailed a code
      And no user exists for "nobody@example.com"

    @REQ-EA-1109
    Scenario: Inside the resend window no second code is minted and the first stays valid
      When "resend@example.com" requests a code 3 times
      Then "resend@example.com" was mailed 1 code
      And presenting the mailed code signs "resend@example.com" in

    @REQ-EA-1110
    Scenario: After the window a new code supersedes the old one
      Given a mailed code for "window@example.com"
      When 61 seconds pass
      And "window@example.com" requests a code
      Then the first code no longer works unless the two happen to be equal
      And presenting the newest code signs "window@example.com" in

    @REQ-EA-1111
    Scenario: Address variants share one budget, so a `+tag` cannot multiply the limit
      Given the application enforces the real rate limits
      When codes are requested for 5 "+tag" variants of "victim@example.com"
      Then a request for the variant "victim+9@example.com" fails with "RateLimited"

    @REQ-EA-1112
    Scenario: Requests from one source are limited to 30 per 15 minutes
      Given the application enforces the real rate limits
      When codes are requested from source "203.0.113.7" for 30 distinct addresses
      Then one more request from source "203.0.113.7" fails with "RateLimited"

  # BEH-EA-273 — spec/behaviors/33-email-otp.md; see also BEH-EA-269, BEH-EA-258
  @BEH-EA-273
  Rule: A correct code signs in once, and every failure is the one InvalidEmailOtp

    @REQ-EA-1113
    Scenario: A correct code signs in exactly once and records amr otp and email
      Given a user "ada@example.com" with an unverified mailbox
      And a mailed code for "ada@example.com"
      When the code is presented for "Ada@Example.com"
      Then a session is issued for "ada@example.com" recorded as "otp" and "email"
      And the mailbox of "ada@example.com" is verified
      When the same code is presented again for "ada@example.com"
      Then it fails with "InvalidEmailOtp"

    @REQ-EA-1114
    Scenario: A correct code signs in over HTTP
      Given a mailed code for "http@example.com"
      When the code is presented over HTTP for "http@example.com"
      Then the response is "200" and sets a session cookie recorded as "otp" and "email"

    @REQ-EA-1115
    Scenario Outline: Every way of failing is the same 401 InvalidEmailOtp over HTTP
      Given a mailed code for "ada@example.com"
      When <presented> is presented over HTTP for <address>
      Then the response is "401" with the tag "InvalidEmailOtp"

      Examples:
        | presented              | address                |
        | "a wrong code"         | "ada@example.com"      |
        | "a code that is too short" | "ada@example.com"  |
        | "letters"              | "ada@example.com"      |
        | "a code for no address"| "nobody@example.com"   |

    @REQ-EA-1116
    Scenario: An expired code is the one InvalidEmailOtp
      Given a mailed code for "late@example.com"
      When 6 minutes pass
      And the code is presented for "late@example.com"
      Then it fails with "InvalidEmailOtp"

    @REQ-EA-1117
    Scenario: A burned code is the one InvalidEmailOtp even when the right value is presented
      Given a mailed code for "guess@example.com"
      When 3 wrong codes are presented for "guess@example.com"
      And the code is presented for "guess@example.com"
      Then it fails with "InvalidEmailOtp"

    @REQ-EA-1118
    Scenario: A value that cannot be a code spends nothing of the code's budget
      Given a mailed code for "ada@example.com"
      When 5 values that cannot be a code are presented for "ada@example.com"
      And the code is presented for "ada@example.com"
      Then a session is issued for "ada@example.com" recorded as "otp" and "email"

    @REQ-EA-1119
    Scenario: Guesses at one address across many codes are limited to 10 per 15 minutes
      Given the application enforces the real rate limits
      When 12 wrong codes are presented for "spray@example.com"
      Then presenting one more for "spray@example.com" fails with "RateLimited"

    @REQ-EA-1120
    Scenario: A brand-new address gets a user only when the code is presented
      Given a mailed code for "new@example.com"
      Then no user exists for "new@example.com"
      When the code is presented for "new@example.com"
      Then a session is issued for "new@example.com" recorded as "otp" and "email"
      And the mailbox of "new@example.com" is verified

    @REQ-EA-1121
    Scenario: A user with a confirmed second factor is diverted and no session is minted
      Given a user "mfa@example.com" with a confirmed second factor
      And a mailed code for "mfa@example.com"
      When the code is presented for "mfa@example.com"
      Then it fails with "TwoFactorRequired" naming "mfa@example.com"
      And no session was issued
      And the second-factor challenge records the first factor as "otp" and "email" via "emailOtp"

    @REQ-EA-1122
    Scenario: A BeforeSignIn veto refuses the sign-in and no session is issued
      Given a mailed code for "banned@example.com"
      And the sign-in of "banned@example.com" is vetoed
      When the code is presented for "banned@example.com"
      Then it fails with "HookAborted"
      And no session was issued

    @REQ-EA-1123
    Scenario: A suspended user gets no session
      Given a user "susp@example.com"
      And a mailed code for "susp@example.com"
      And "susp@example.com" is suspended
      When the code is presented for "susp@example.com"
      Then it fails with "UserSuspended"
      And no session was issued

  # BEH-EA-274 — spec/behaviors/33-email-otp.md; see also ADR-EA-021
  @BEH-EA-274
  Rule: The code is a Verification row with no table of its own, and SMS is a later restricted plugin over it

    @REQ-EA-1124
    Scenario: The plugin declares no table
      Then the "emailOtp" plugin declares no table

    @REQ-EA-1125
    Scenario: The code lives in Verification under the identifier email-otp and the normalised address
      Given a mailed code for "Ada@Example.com"
      Then the mailed code consumes under the identifier "email-otp:ada@example.com"

    @REQ-EA-1126
    Scenario: The plugin offers no SMS channel and records the method as otp and email, never sms
      Given a mailed code for "ada@example.com"
      Then the "emailOtp" contract exposes only "POST /email-otp/request" and "POST /email-otp/verify"
      When the code is presented for "ada@example.com"
      Then a session is issued for "ada@example.com" recorded as "otp" and "email"
