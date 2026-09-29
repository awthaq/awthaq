# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# BCR-010/P20a: authored against the shipped `@awthaq/magic-link`. Every scenario drives the real
# `MagicLink` plugin over in-memory stores with the real `@awthaq/two-factor` gates (so the MFA
# divert is a real divert), through the web handler where the scenario is about the wire and
# through the service where it is about a clock or an error tag. The recipient is played from the
# captured mail: a token is never read from the store.

@passwordless @magic-link
Feature: Magic Link

  # BEH-EA-267 — spec/behaviors/32-magic-link.md; see also MLO-005
  @BEH-EA-267
  Rule: A magic link is consumed only by POST, and its token travels in the URL fragment

    @REQ-EA-1075
    Scenario: The magic-link contract declares no GET or HEAD endpoint
      Given the magic-link contract
      When its endpoints are listed
      Then every endpoint is a "POST"
      And the endpoint paths are "/magic-link/request" and "/magic-link/verify"

    @REQ-EA-1076
    Scenario: A GET carrying a link's token in a query string consumes nothing
      Given a mailed magic link for "ada@example.com"
      When a "GET" request carries the token in the query string of "/magic-link/verify"
      And a "GET" request carries the token in the query string of "/magic-link"
      Then both requests are refused as unrouted
      And a POST of the same token to "/magic-link/verify" still signs "ada@example.com" in

    @REQ-EA-1077
    Scenario: A token in the query string of a POST is not accepted
      Given a mailed magic link for "ada@example.com"
      When a "POST" to "/magic-link/verify" carries the token only in the query string
      Then the response is "400"
      And a POST of the same token to "/magic-link/verify" still signs "ada@example.com" in

    @REQ-EA-1078
    Scenario: The mailed URL carries the token in its fragment
      Given the application configures the magic-link base URL "https://app.example.com"
      When "ada@example.com" requests a magic link
      Then the mailed URL is "https://app.example.com/magic-link#token=" followed by the encoded token
      And the mailed URL has no query string and nothing of the token before its fragment

  # BEH-EA-268 — spec/behaviors/32-magic-link.md; see also BEH-EA-064, BEH-EA-063
  @BEH-EA-268
  Rule: Requesting a link answers 202 for every address and mails at most one link per window

    @REQ-EA-1079
    Scenario: A known and an unknown address get the identical 202
      Given a user "ada@example.com"
      When "ada@example.com" and "nobody@example.com" each request a magic link over HTTP
      Then both responses are "202" with the same empty body

    @REQ-EA-1080
    Scenario: With sign-up off an unknown address is answered like any other and not mailed
      Given the application disallows sign-up through magic links
      And a user "ada@example.com"
      When "ada@example.com" and "nobody@example.com" each request a magic link
      Then only "ada@example.com" was mailed a magic link
      And no user exists for "nobody@example.com"

    @REQ-EA-1081
    Scenario: The mail carries a redacted token and its expiry
      When "ada@example.com" requests a magic link
      Then the "magic-link" mail to "ada@example.com" carries a redacted "token" and an expiry
      And the mail carries no URL because no base URL or link builder is configured

    @REQ-EA-1082
    Scenario: An address is mailed at most one link per resend window
      When "again@example.com" requests a magic link 3 times
      Then "again@example.com" was mailed 1 magic link
      When 61 seconds pass
      And "again@example.com" requests a magic link
      Then "again@example.com" was mailed 2 magic links

    @REQ-EA-1083
    Scenario: Address variants share one budget, so a `+tag` cannot multiply the limit
      Given the application enforces the real rate limits
      When links are requested for 5 "+tag" variants of "victim@example.com"
      Then a request for the variant "victim+9@example.com" fails with "RateLimited"

    @REQ-EA-1084
    Scenario: Requests from one source are limited to 30 per 15 minutes
      Given the application enforces the real rate limits
      When links are requested from source "203.0.113.7" for 30 distinct addresses
      Then one more request from source "203.0.113.7" fails with "RateLimited"

  # BEH-EA-269 — spec/behaviors/32-magic-link.md; see also ARF-005, BEH-EA-261
  @BEH-EA-269
  Rule: Presenting a link proves the mailbox and signs in through the shared gate and the MFA divert

    @REQ-EA-1085
    Scenario: A link signs an existing user in once, verifies the mailbox and records amr email
      Given a user "ada@example.com" with an unverified mailbox
      And a mailed magic link for "ada@example.com"
      When the link is presented
      Then a session is issued for "ada@example.com" recorded as "email"
      And the mailbox of "ada@example.com" is verified
      When the same link is presented again
      Then it fails with "MagicLinkConsumed"
      And a "magicLink" sign-in failure was published

    @REQ-EA-1086
    Scenario: A brand-new address gets a user only when the link is presented
      Given a mailed magic link for "new@example.com"
      Then no user exists for "new@example.com"
      When the link is presented
      Then a session is issued for "new@example.com" recorded as "email"
      And the mailbox of "new@example.com" is verified
      And a user creation was published for "new@example.com"

    @REQ-EA-1087
    Scenario: An expired link fails with MagicLinkConsumed
      Given a mailed magic link for "late@example.com"
      When 11 minutes pass
      And the link is presented
      Then it fails with "MagicLinkConsumed"

    @REQ-EA-1088
    Scenario Outline: A malformed or foreign token fails with the one MagicLinkConsumed
      When <token> is presented as a magic link
      Then it fails with "MagicLinkConsumed"

      Examples:
        | token                      |
        | "an empty string"          |
        | "arbitrary text"           |
        | "a token of another purpose" |

    @REQ-EA-1089
    Scenario: A token of another purpose is refused before anything is consumed
      Given a token of another purpose
      When it is presented as a magic link
      Then it fails with "MagicLinkConsumed"
      And the token of the other purpose can still be consumed for its own purpose

    @REQ-EA-1090
    Scenario: A BeforeSignIn veto refuses the sign-in and no session is issued
      Given a mailed magic link for "banned@example.com"
      And the sign-in of "banned@example.com" is vetoed
      When the link is presented
      Then it fails with "HookAborted" carrying the code "USER_BANNED"
      And no session was issued

    @REQ-EA-1091
    Scenario: A suspended user gets no session
      Given a user "susp@example.com"
      And a mailed magic link for "susp@example.com"
      And "susp@example.com" is suspended
      When the link is presented
      Then it fails with "UserSuspended"
      And no session was issued

    @REQ-EA-1092
    Scenario: A user with a confirmed second factor is diverted and no session is minted
      Given a user "mfa@example.com" with a confirmed second factor
      And a mailed magic link for "mfa@example.com"
      When the link is presented
      Then it fails with "TwoFactorRequired" naming "mfa@example.com"
      And no session was issued
      And the second-factor challenge records the first factor as "email" via "magicLink"

    @REQ-EA-1093
    Scenario: A magic link never touches an existing account's credentials
      Given a user "ada@example.com" with a password credential
      And a mailed magic link for "ada@example.com"
      When the link is presented
      Then a session is issued for "ada@example.com" recorded as "email"
      And the password credential of "ada@example.com" is unchanged and still verifies

    @REQ-EA-1094
    Scenario: Presenting one token repeatedly is limited by its public id
      Given the application enforces the real rate limits
      When the same made-up token is presented 5 times
      Then presenting it a sixth time fails with "RateLimited"

  # BEH-EA-270 — spec/behaviors/32-magic-link.md; see also ARF-009
  @BEH-EA-270
  Rule: A magic link is a Verification row under its own purpose, with no table of its own

    @REQ-EA-1095
    Scenario: The token is a magic-link identifier plus a secret and names neither the user nor the address
      Given a user "ada@example.com"
      And a mailed magic link for "ada@example.com"
      Then the token starts with "magic-link:"
      And the token contains neither the user's id nor the address

    @REQ-EA-1096
    Scenario: The public id is 128 random bits, different for every link
      Given a mailed magic link for "one@example.com"
      And a mailed magic link for "two@example.com"
      Then each token's public id decodes to 16 bytes
      And the two public ids differ

    @REQ-EA-1097
    Scenario: The plugin declares no table
      Then the "magicLink" plugin declares no table

    @REQ-EA-1098
    Scenario: A link issued for an address decides whom presenting it creates
      Given a mailed magic link for "new@example.com"
      When the link is presented
      Then a user exists for "new@example.com"
