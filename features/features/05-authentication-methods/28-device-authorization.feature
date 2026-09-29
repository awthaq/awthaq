# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@authentication-methods @device-authorization
Feature: Device Authorization

  # BEH-EA-299 — spec/behaviors/37-device-authorization.md; see also spec/models/13-device-authorization.md "Security parameters"
  @BEH-EA-299
  Rule: A code request mints a hashed device code and an unambiguous user code for a registered client

    @REQ-EA-1193
    Scenario: A registered client is answered the RFC 8628 fields, with the user code shown as XXXX-XXXX
      Given a registered device client "awthaq-cli"
      When the client requests a device code
      Then the answer carries a device code, a user code, the verification URIs, an expiry of 900 seconds and an interval of 5 seconds
      And the user code is 8 symbols of the alphabet "BCDFGHJKLMNPQRSTVWXZ" shown as "XXXX-XXXX"

    @REQ-EA-1194
    Scenario: An unregistered client, and a scope the client is not registered for, are refused
      Given a registered device client "awthaq-cli"
      When a client named "nobody" requests a device code
      Then the request is refused as "invalid_client"
      When the registered client requests a device code for the scope "admin"
      Then the request is refused as "invalid_scope"

    @REQ-EA-645
    Scenario: User codes are matched exactly after normalization and stored only as a hash
      Given a generated user code shown as "XXXX-XXXX"
      When it is entered lower-cased with spaces instead of the hyphen
      Then it is normalized and matches exactly
      And a code one character off does not match
      And the stored row holds only the code's hash

  # BEH-EA-300 — spec/behaviors/37-device-authorization.md; see also spec/models/13-device-authorization.md "Design constraints" 1 to 5
  @BEH-EA-300
  Rule: The poll answers the RFC 8628 states, enforces its interval and cleans up on discovery

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

    @REQ-EA-1195
    Scenario: The verification page rejects an expired code without deleting it
      Given a device code whose lifetime has elapsed
      When a signed-in user opens the verification page for it
      Then the page answers "InvalidUserCode"
      And the grant row still exists

    @REQ-EA-1196
    Scenario: A device code presented by another client, or one that never existed, is invalid_grant
      Given a device code that has been requested and not yet approved
      When another registered client polls with that device code
      Then the poll answers "invalid_grant"
      When a device polls with a device code that was never issued
      Then the poll answers "invalid_grant"

    @REQ-EA-1197
    Scenario: The token endpoint refuses another grant type and an empty device code
      Given a registered device client "awthaq-cli"
      When a device posts to "/device/token" with the grant type "password"
      Then the wire answer is 400 "unsupported_grant_type"
      When a device posts to "/device/token" with an empty device code
      Then the wire answer is 400 "invalid_request"

  # BEH-EA-301 — spec/behaviors/37-device-authorization.md; see also spec/models/13-device-authorization.md "Design constraints" 6
  @BEH-EA-301
  Rule: Opening the verification page claims an unclaimed code for the first user and shows context only to them

    @REQ-EA-641
    Scenario: Opening the verification page claims an unclaimed code idempotently for the same session
      Given a pending, unclaimed user code and a signed-in session
      When that session opens the verification page twice
      Then the code is claimed by that session's user exactly once
      And a different session opening the page afterwards cannot claim it

    @REQ-EA-643
    Scenario: An unrelated caller sees only the code and its status
      Given a claimed user code
      When an anonymous caller, or a different user, opens the verification page
      Then only "user_code" and "status" are disclosed
      And no client or scope context is shown

    @REQ-EA-1198
    Scenario: The claiming user sees which client asks for what
      Given a registered device client "set-top-box" with the scope "playback"
      And a claimed user code for the client "set-top-box" and the scope "playback"
      When the claiming user opens the verification page
      Then the page names the client "set-top-box" and the scope "playback"

    @REQ-EA-1199
    Scenario: An anonymous caller never claims a code
      Given a pending, unclaimed user code and a signed-in session
      When an anonymous caller opens the verification page
      Then the code stays unclaimed

  # BEH-EA-302 — spec/behaviors/37-device-authorization.md; see also spec/models/13-device-authorization.md "Design constraints" 2 and 6
  @BEH-EA-302
  Rule: Approve and deny are compare-and-swap decisions by the claiming user only

    @REQ-EA-642
    Scenario: Approving without a prior claim is refused
      Given a pending user code that no session has claimed
      When a signed-in session tries to approve it
      Then the approval is refused as not claimed

    @REQ-EA-1200
    Scenario: A code claimed by another user is indistinguishable from an unknown one
      Given a claimed user code
      When a different signed-in user tries to approve it
      Then the approval is refused as "InvalidUserCode"

    @REQ-EA-1201
    Scenario: Two racing decisions cannot both win, and a decided code is not pending again
      Given a claimed user code
      When the claiming user approves and denies it concurrently
      Then exactly one decision succeeds
      And deciding the code again is refused as "InvalidUserCode"

    @REQ-EA-1202
    Scenario: An impersonation session cannot decide
      Given a claimed user code
      When an impersonation session of the claiming user tries to approve it
      Then the approval is refused as "DeviceApprovalRefused"

    @REQ-EA-1203
    Scenario: A required assurance level gates an approval but never a denial
      Given the plugin requires the assurance level "aal2"
      And a claimed user code held by a session that authenticated with a password only
      When that session tries to approve it
      Then the approval is refused as "DeviceApprovalRefused"
      When that session denies it
      Then the code is denied

  # BEH-EA-303 — spec/behaviors/37-device-authorization.md; see also spec/models/13-device-authorization.md "Security parameters"
  @BEH-EA-303
  Rule: Failed user-code lookups and code requests spend rate-limit budgets

    @REQ-EA-644
    Scenario: Wrong user-code attempts are rate-limited per IP and per session
      Given the verification endpoint's limit of 5 failed user-code lookups per 15 minutes
      When a caller submits 6 wrong user codes within that window
      Then the sixth attempt is rejected as rate limited
      And the limit applies both per IP and per session

    @REQ-EA-1204
    Scenario: Code requests are limited to 5 per window per source address
      Given the code endpoint's limit of 5 requests per 15 minutes per address
      When one address requests 6 device codes within that window
      Then the sixth request is rejected as rate limited
      And another address is still served

  # BEH-EA-304 — spec/behaviors/37-device-authorization.md; see also spec/models/13-device-authorization.md "Design constraints" 3
  @BEH-EA-304
  Rule: Redemption issues an ordinary bearer session, only after winning an atomic claim

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

    @REQ-EA-646
    Scenario: The issued session records the device's address and user agent
      Given an approved device grant
      When the device redeems it
      Then the issued session appears in the approving user's session list
      And it carries the device's client address and user agent

    @REQ-EA-1205
    Scenario: The session inherits how the approving session authenticated
      Given an approved device grant whose approving session authenticated with a password and a second factor
      When the device redeems it
      Then the issued session records the amr "pwd", "otp" and "mfa"

    @REQ-EA-1206
    Scenario: The approved poll answers a Bearer token, no-store, and sets no cookie
      Given an approved device grant
      When the device redeems it over the wire
      Then the wire answer is 200 with "token_type" "Bearer" and an "access_token"
      And the response is "no-store" and sets no cookie

    @REQ-EA-1207
    Scenario: A user with a confirmed second factor is diverted unless the approving session proved one
      Given a user with a confirmed second factor whose approving session authenticated with a password only
      And an approved device grant for that session
      When the device redeems it
      Then the poll answers "access_denied"
      And the grant row no longer exists

    @REQ-EA-1208
    Scenario: A suspended user gets no session
      Given an approved device grant
      And the approving user is then suspended
      When the device redeems it
      Then the redemption is refused as "UserSuspended"
      And no session is minted

  # BEH-EA-305 — spec/behaviors/37-device-authorization.md
  @BEH-EA-305
  Rule: Clients are public, registered by an operator and revocable

    @REQ-EA-1209
    Scenario: A registered client can be revoked, after which it obtains no code
      Given an operator registers the device client "living-room-tv" named "Living-room TV"
      When the client "living-room-tv" requests a device code
      Then the answer carries a device code
      When the operator revokes the client "living-room-tv"
      And the client "living-room-tv" requests a device code
      Then the request is refused as "invalid_client"

    @REQ-EA-1210
    Scenario: A configured client id cannot be registered again
      Given a registered device client "awthaq-cli"
      When an operator registers the device client "awthaq-cli" named "Impostor"
      Then the registration is refused as "DeviceAuthorization/ClientExists"

  # BEH-EA-306 — spec/behaviors/37-device-authorization.md; see also ADR-EA-029, ADR-EA-031
  @BEH-EA-306
  Rule: Grants are audited, erased, exported and retained like any personal data

    @REQ-EA-1211
    Scenario: An approval is audited with the approver and the client, and never a code
      Given a claimed user code
      When the claiming user approves it
      Then the audit trail holds one "auth.deviceAuthorization.approved" row naming that user and the client
      And no audit row holds the device code or the user code

    @REQ-EA-1212
    Scenario: Erasing a user deletes the grants they claimed, and only theirs
      Given a claimed user code and another user's claimed user code
      When the first user is erased
      Then only the erased user's grant is gone

    @REQ-EA-1213
    Scenario: The data export lists the person's grants without any code or hash
      Given a claimed user code
      When the claiming user's data is exported
      Then the device-authorization section names the client and the status "pending"
      And it holds no code and no hash

    @REQ-EA-1214
    Scenario: Purging removes only grants past their expiry
      Given one device code that expired and one that is still live
      When the operator purges expired grants
      Then one grant is reported purged and the live one remains
