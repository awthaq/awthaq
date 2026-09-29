# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.
#
# DAG-007: the `DeviceAuthorization` plugin (RFC 8628) has no code and no
# BEH-EA range yet, so these scenarios trace to its model,
# spec/models/13-device-authorization.md (MOD-EA-013), whose "Security
# parameters" and "Design constraints" sections they pin ahead of the
# implementation. Registered `@skip @unwired`; wiring them (and giving them BEH
# ids) belongs to the milestone that schedules the plugin.
# Blocked by: the device-authorization-grant workstream (DAG-005, plan P16).

@authentication-methods @device-authorization @skip @unwired
Feature: Device authorization grant (RFC 8628)

  # MOD-EA-013 — spec/models/13-device-authorization.md, "Design constraints"
  @MOD-EA-013
  Rule: The polling state machine is race-safe and rate-shaped

    @REQ-EA-634
    Scenario: A pending grant answers authorization_pending, then an approved one issues a session exactly once
      Given a device code that has been requested and not yet approved
      When the device polls "/device/token" at the advised interval
      Then the poll answers "authorization_pending"
      When the user approves the code on a second, authenticated device
      And the device polls again
      Then a session is issued for the approving user and the grant is consumed

    @REQ-EA-635
    Scenario: A denied grant answers access_denied and is deleted on observation
      Given a device code that the user has denied
      When the device polls "/device/token"
      Then the poll answers "access_denied"
      And the grant row no longer exists

    @REQ-EA-636
    Scenario: Polling faster than the interval answers slow_down and raises the server-side interval
      Given a device code being polled at the advised interval
      When the device polls again before the interval has elapsed
      Then the poll answers "slow_down"
      And the interval the server advises increases by 5 seconds

    @REQ-EA-637
    Scenario: A poll rejected as pending still counts toward slow_down throttling
      Given a pending device code that was polled once
      When the device polls again immediately, before the interval has elapsed
      Then that second poll answers "slow_down"
      And a poll made after the interval answers "authorization_pending" rather than skipping the throttle

    @REQ-EA-638
    Scenario: An expired code answers expired_token and its row is cleaned up on first discovery
      Given a device code whose lifetime has elapsed
      When the device polls "/device/token"
      Then the poll answers "expired_token"
      And the grant row no longer exists

    @REQ-EA-639
    Scenario: Two concurrent polls after approval issue exactly one session, and the loser gets invalid_grant
      Given an approved device code
      When two polls for it arrive concurrently
      Then exactly one poll receives a session
      And the other answers "invalid_grant"
      And only one session exists for that grant

    @REQ-EA-640
    Scenario: A session is created only after the atomic claim, never before
      Given an approved device code and a poll that will lose the race
      When the losing poll is processed
      Then no session is ever minted from the device code it did not win

  # MOD-EA-013 — spec/models/13-device-authorization.md, "Design constraints" 6
  @MOD-EA-013
  Rule: Verification and approval are claim-then-decide

    @REQ-EA-641
    Scenario: Opening the verification page claims an unclaimed code idempotently for the same session
      Given a pending, unclaimed user code and a signed-in session
      When that session opens the verification page twice
      Then the code is claimed by that session's user exactly once
      And a different session opening the page afterwards cannot claim it

    @REQ-EA-642
    Scenario: Approving without a prior claim is refused
      Given a pending user code that no session has claimed
      When a signed-in session tries to approve it
      Then the approval is refused as not claimed

    @REQ-EA-643
    Scenario: An unrelated caller sees only the code and its status
      Given a claimed user code
      When an anonymous caller, or a different user, opens the verification page
      Then only "user_code" and "status" are disclosed
      And no client or scope context is shown

  # MOD-EA-013 — spec/models/13-device-authorization.md, "Security parameters"
  @MOD-EA-013
  Rule: User codes are high-entropy, normalized, hashed and rate-limited

    @REQ-EA-644
    Scenario: Wrong user-code attempts are rate-limited per IP and per session
      Given the verification endpoint's limit of 5 failed user-code lookups per 15 minutes
      When a caller submits 6 wrong user codes within that window
      Then the sixth attempt is rejected as rate limited
      And the limit applies both per IP and per session

    @REQ-EA-645
    Scenario: User codes are matched exactly after normalization and stored only as a hash
      Given a generated user code shown as "XXXX-XXXX"
      When it is entered lower-cased with spaces instead of the hyphen
      Then it is normalized and matches exactly
      And a code one character off does not match
      And the stored row holds only the code's hash

    @REQ-EA-646
    Scenario: The issued session records the device's address and user agent
      Given an approved device grant
      When the device redeems it
      Then the issued session appears in the approving user's session list
      And it carries the device's client address and user agent
