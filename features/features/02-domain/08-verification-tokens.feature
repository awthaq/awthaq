# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@domain @verification-tokens
Feature: Verification Tokens

  # BEH-EA-057 — spec/behaviors/08-verification-tokens.md
  @BEH-EA-057
  Rule: A verification token is scoped to one purpose

    @REQ-EA-160
    Scenario: A token issued for email verification carries a purpose-scoped identifier
      Given a request to issue an email-verification token for "alice@example.com"
      When the VerificationToken row is created
      Then its identifier is scoped to "verify-email:<token>"

    @REQ-EA-161
    Scenario: A token issued for one purpose does not satisfy a check for another purpose
      Given a VerificationToken issued for email verification
      When that token is presented to the password-reset consumption check
      Then the password-reset check fails, since the token's identifier is not scoped to "reset-password:"

    @REQ-EA-162
    Scenario: A user can hold a live password-reset token and a live email-verification token at once
      Given a user "alice" with a live email-verification token
      When a password-reset token is also issued for "alice"
      Then both tokens coexist as structurally distinct VerificationToken rows

  # BEH-EA-058 — spec/behaviors/08-verification-tokens.md; see also INV-EA-009
  @BEH-EA-058
  Rule: A verification token's consumption and the state change it authorizes commit in one transaction

    @REQ-EA-163
    Scenario: Confirming a password reset consumes the token and applies the password change as one transaction
      Given a live password-reset token for "alice"
      When "alice" confirms the reset with that token
      Then the token is marked consumed
      And the password change is applied
      And both effects commit under one SQL transaction

    @REQ-EA-164
    Scenario: Two concurrent confirmations bearing the same token never both apply the change
      Given a live password-reset token for "alice"
      When two concurrent requests race to confirm the reset using that same token
      Then at most one request applies the password change
      And the token is consumed exactly once, not twice

    @REQ-EA-165
    Scenario: A failure applying the authorized state change leaves the token unconsumed
      Given a live password-reset token for "alice"
      When confirming the reset fails while applying the password change
      Then the token is not left marked consumed
      And the transaction rolls back both the consumption and the state change together

  # BEH-EA-059 — spec/behaviors/08-verification-tokens.md; see also INV-EA-010
  @BEH-EA-059
  Rule: Replaying an already-consumed or unknown token publishes auth.token.replay

    @REQ-EA-166
    Scenario: Replaying an already-consumed token fails and publishes a replay event
      Given a VerificationToken that has already been consumed
      When the same token is presented for consumption again
      Then the request fails with "410 TokenConsumed"
      And an "auth.token.replay" event is published to AuthEvents

    @REQ-EA-167
    Scenario: Presenting an expired token fails and publishes a replay event
      Given a VerificationToken past its expiresAt
      When the token is presented for consumption
      Then the request fails
      And an "auth.token.replay" event is published to AuthEvents

    @REQ-EA-168
    Scenario: Presenting an unknown token identifier fails and publishes a replay event
      Given a token identifier that does not correspond to any VerificationToken row
      When it is presented for consumption
      Then the request fails
      And an "auth.token.replay" event is published to AuthEvents

    @REQ-EA-169
    Scenario: The replay event is published independently of the audit table's own record
      Given an already-consumed token is presented again
      When the replay attempt is handled
      Then "auth.token.replay" is published to AuthEvents
      And this publication happens regardless of whatever the audit table separately records as the durable record of record

    @REQ-EA-170
    Scenario: The first, successful consumption of a token does not publish a replay event
      Given a VerificationToken that has not yet been consumed
      When it is consumed for the first time
      Then no "auth.token.replay" event is published

  # BEH-EA-060 — spec/behaviors/08-verification-tokens.md
  @BEH-EA-060
  Rule: A verification token is hashed at rest

    @REQ-EA-171
    Scenario: Issuing a verification token persists only its hash
      Given a request to issue a password-reset token for "alice"
      When the VerificationToken row is created
      Then the persisted row stores a hash of the token value
      And it does not store the token's plaintext

    @REQ-EA-172
    Scenario: Consuming a token hashes the presented value the same way before comparing
      Given a live VerificationToken whose hash was computed at issuance
      When the caller presents the plaintext token for consumption
      Then the presented value is hashed the same way and compared against the stored hash

    @REQ-EA-173
    Scenario: A disclosure of the verification-token table alone does not permit completing the gated action
      Given the VerificationToken table's rows have been disclosed
      When an attacker presents a disclosed row's stored hash directly as if it were the plaintext token
      Then the consumption check fails, since presenting the hash does not reproduce the plaintext token

  # BEH-EA-061 — spec/behaviors/08-verification-tokens.md
  @BEH-EA-061
  Rule: A verification token carries an expiry, treated as invalid before physical removal

    @REQ-EA-174
    Scenario: A token past its expiresAt is rejected by a read operation even though the row still exists
      Given a VerificationToken whose expiresAt has passed and whose row has not been physically deleted
      When the token is presented for consumption
      Then it is rejected as invalid

    @REQ-EA-175
    Scenario: Expiry enforcement does not depend on a background cleanup process ever having run
      Given a VerificationToken that expired long ago and no cleanup process has ever executed
      When the token is presented for consumption
      Then it is rejected as invalid based on its expiresAt alone

  # BEH-EA-062 — spec/behaviors/08-verification-tokens.md
  @BEH-EA-062
  Rule: Consuming a verification token is race-safe — at most one concurrent caller succeeds

    @REQ-EA-176
    Scenario: Exactly one of several concurrent callers consuming the same token succeeds
      Given a live VerificationToken identifier
      When 5 callers race to consume that same token identifier concurrently
      Then at most one caller receives the non-expired row as a success

    @REQ-EA-177
    Scenario: Every other concurrent caller receives "not found"
      Given a live VerificationToken identifier
      When 5 callers race to consume that same token identifier concurrently
      Then every caller other than the winner receives "not found"

    @REQ-EA-178
    Scenario: The token row is gone afterward regardless of which caller won
      Given a live VerificationToken identifier
      When 5 callers race to consume that same token identifier concurrently
      Then the VerificationToken row no longer exists once the race resolves, regardless of which caller won

    @REQ-EA-179
    Scenario: A caller that ignores the consume result is responsible for any resulting double-application
      Given a live VerificationToken identifier
      When a caller applies its state change unconditionally without gating on a non-null consume result
      Then the race-safety guarantee does not protect that caller
      And any resulting double-application is attributable to the caller, not to the consumption operation

  # BEH-EA-063 — spec/behaviors/08-verification-tokens.md
  @BEH-EA-063
  Rule: A reservation-style identifier answers "who claimed this first," independent of any column-level uniqueness

    @REQ-EA-180
    Scenario: The first reservation of an identifier succeeds
      Given no reservation exists for identifier "promote-user-42"
      When a caller reserves identifier "promote-user-42"
      Then the reservation returns "true"

    @REQ-EA-181
    Scenario: Every subsequent reservation of the same identifier fails while the first has not expired
      Given identifier "promote-user-42" was just reserved and has not expired
      When a second caller reserves the same identifier "promote-user-42"
      Then the reservation returns "false"

    @REQ-EA-182
    Scenario: A new reservation of the identifier can succeed again once the prior reservation expires
      Given identifier "promote-user-42" was reserved and that reservation has since expired
      When a caller reserves identifier "promote-user-42" again
      Then the reservation returns "true"

    @REQ-EA-183
    Scenario: A store unable to make reservation atomic fails closed rather than reporting a false success
      Given a store implementation that cannot guarantee atomic reservation
      When a caller attempts to reserve an identifier against that store
      Then the reservation fails closed
      And it never reports a false success

  # BEH-EA-064 — spec/behaviors/08-verification-tokens.md
  @BEH-EA-064
  Rule: Purpose-scoped flows respond uniformly regardless of whether their target exists

    @REQ-EA-184
    Scenario Outline: A verification-token-issuing endpoint responds identically whether or not the target account exists
      Given a "<flow>" request submitted for an email <email-state>
      When the request is handled
      Then the response is "202 Accepted"
      And the response body does not reveal whether the account exists

      Examples:
        | flow                      | email-state                  |
        | password reset            | belonging to an existing account |
        | password reset            | belonging to no account          |
        | email-verification resend | belonging to an existing account |
        | email-verification resend | belonging to no account          |
