@domain @sessions
Feature: Sessions

  # BEH-EA-049 — spec/behaviors/07-sessions.md; see also ADR-EA-014
  @BEH-EA-049
  Rule: A session token is an opaque id.secret pair

    # AH-005: the "redacted in any log or span" clause runs against the World's
    # RedactionGuard, which records every span, log line and published event and flags a
    # `Redacted` instance or the watched secret.
    @REQ-EA-136
    Scenario: Issuing a session returns a token composed of a public id and a secret
      Given a signed-in user "alice"
      When a session is issued for "alice"
      Then the returned token has the shape "<id>.<secret>"
      And the secret component is redacted in any log or span

    # AH-005: the World runs Sessions over a real SQLite table, so the row is read raw.
    @REQ-EA-137
    Scenario: The persisted session row alone never yields the secret
      Given a session has been issued for "alice"
      When the persisted Session row is read directly, without the value returned at issuance
      Then the secret component cannot be reconstructed from it

  # BEH-EA-050 — spec/behaviors/07-sessions.md; see also INV-EA-007
  @BEH-EA-050
  Rule: Only SHA-256(secret) is persisted; the plaintext secret is never stored

    @REQ-EA-138
    Scenario: Issuing a session persists only the hash of the secret
      Given a signed-in user "alice"
      When a session is issued for "alice"
      Then the persisted Session row stores "SHA-256(secret)"
      And the persisted Session row does not store the plaintext secret

    # AH-005: the hash-then-compare mechanism is observed through its consequences on a real
    # row (the token verifies, the stored digest is not itself a credential, no plaintext is
    # stored); the World pins the row's digest to "s3cr3t" so the literal secret is honest.
    @REQ-EA-139
    Scenario: Verifying a presented token hashes the presented secret rather than comparing plaintext
      Given a session issued for "alice" with secret "s3cr3t"
      When the token is presented for verification
      Then the presented secret is hashed and the hash is compared against the stored hash
      And no comparison is made against a stored plaintext value

    @REQ-EA-140
    Scenario: A leaked sessions table cannot be replayed as a bearer credential
      Given the Session table's rows have been disclosed, as by a backup or a compromised read replica
      When an attacker attempts to authenticate using a disclosed row's stored hash as if it were the secret
      Then authentication fails, because the disclosed hash cannot be replayed as a token

  # BEH-EA-051 — spec/behaviors/07-sessions.md; see also INV-EA-008
  @BEH-EA-051
  Rule: A session carries independent absolute and idle expiries; idle refresh never extends the absolute deadline

    # AH-005: the World's TestClock is in the same runtime the handler serves from, so
    # `advance` moves the clock every row timestamp and the CSRF token's age check read.
    @REQ-EA-141
    Scenario: A session's absolute expiry is fixed at issuance and unaffected by activity
      Given a session issued for "alice" with an absolute expiry of 30 days from issuance
      When "alice" makes requests using that session every day for 10 days
      Then the session's absolute expiry remains exactly 30 days from issuance

    @REQ-EA-142
    Scenario: A session's idle expiry is pushed forward by activity
      Given a session for "alice" with an idle expiry 1 hour from its last touch
      When "alice" makes a request using that session
      Then the session's idle expiry is pushed forward by activity

    @REQ-EA-143
    Scenario: Idle refresh never advances the idle expiry past the absolute expiry
      Given a session for "alice" whose absolute expiry is 10 minutes away and whose idle window is 1 hour
      When "alice" makes a request using that session
      Then the session's idle expiry is capped at the absolute expiry
      And the idle expiry is not extended 1 hour past the absolute expiry

    @REQ-EA-144
    Scenario: A session touched continuously without pause still expires at its original absolute deadline
      Given a session for "alice" with an absolute expiry of 30 days from issuance
      When "alice" makes a request using that session every minute for the full 30 days
      Then the session is no longer valid once the original absolute expiry passes, regardless of the continuous activity

  # BEH-EA-052 — spec/behaviors/07-sessions.md
  @BEH-EA-052
  Rule: Idle-window refresh is throttled to at most one write per touchEvery

    @REQ-EA-145
    Scenario: A single request within touchEvery does not trigger a refresh write
      Given a session last touched 10 minutes ago
      And "touchEvery" is configured to 1 hour
      When a request is served using that session
      Then no idle-refresh write occurs

    @REQ-EA-146
    Scenario: Repeated requests within touchEvery collapse to at most one refresh write
      Given a session last touched 10 minutes ago
      And "touchEvery" is configured to 1 hour
      When 50 requests are served using that session within the next 5 minutes
      Then at most one idle-refresh write occurs

  # BEH-EA-053 — spec/behaviors/07-sessions.md
  @BEH-EA-053
  Rule: A new session is issued — never reused — at sign-in and at privilege change; the superseded row is tombstoned atomically with the new row's insertion

    @REQ-EA-147
    Scenario: Signing in issues a newly minted session rather than reusing an existing one
      Given "alice" has no existing session
      When "alice" signs in
      Then a newly minted session is issued for "alice"

    # SMS-008: split from the original "password change | email change" Outline — the
    # password-change row is real and wire-testable (POST /change-password); the
    # email-change row is a separate skipped scenario below.
    @REQ-EA-148
    Scenario: A password change issues a new session and tombstones the superseded row
      Given a signed-in user "alice" with session "s0"
      When "alice" performs a "password change"
      Then a newly minted session replaces "s0"
      And session "s0" no longer verifies, its row tombstoned rather than left valid

    # @skip: no changeEmail capability exists in any package (no changeEmail-shaped endpoint
    # or Users operation), so there is nothing to perform; un-skip when one ships (SMS-008)
    @skip
    Scenario: An email change issues a new session and tombstones the superseded row
      Given a signed-in user "alice" with session "s0"
      When "alice" performs a "email change"
      Then a newly minted session replaces "s0"
      And session "s0" no longer verifies, its row tombstoned rather than left valid

  # BEH-EA-054 — spec/behaviors/07-sessions.md
  @BEH-EA-054
  Rule: Sessions expose a device list, per-device revocation, and revoke-others

    @REQ-EA-149
    Scenario: A user lists their own live sessions
      Given "alice" has 3 active sessions
      When "alice" requests her session list
      Then she sees 3 sessions, each with its own userAgent and a "current" flag on the session serving the request

    @REQ-EA-150
    Scenario: Revoking one session by id ends that session only
      Given "alice" has sessions "s1" and "s2"
      When "alice" revokes session "s1"
      Then session "s1" is no longer valid
      And session "s2" remains valid

    @REQ-EA-151
    Scenario: Revoke-others ends every session except the caller's current one
      Given "alice" has sessions "s1" (current), "s2", and "s3"
      When "alice" revokes all other sessions
      Then "s2" and "s3" are no longer valid
      And "s1" remains valid

    # TIR-006: the sixth session endpoint (POST /session/revoke-all) kills the caller's own
    # session too and expires its cookie (CSS-002).
    Scenario: Revoking all sessions also ends the caller's current session
      Given "alice" has sessions "s1" (current), "s2", and "s3"
      When "alice" revokes all of her sessions
      Then "s1", "s2", and "s3" are no longer valid
      And the response expires the "__Host-session" cookie

    # AH-005: the World's `gate` endpoint sits behind the real Authentication middleware and
    # blocks until released, giving the fiber-interleaving control this needs.
    @REQ-EA-152
    Scenario: A request already validated before a concurrent revoke is allowed to complete
      Given "alice"'s session "s1" is validated by the authentication middleware for an in-flight request
      When session "s1" is revoked by a concurrent request before "s1"'s handler completes
      Then the in-flight request completes normally on the principal it already resolved
      And the next request presenting session "s1" is rejected

    @REQ-EA-153
    Scenario: Only the single already-in-flight request is granted the bounded window, never a second one
      Given "alice"'s session "s1" is validated by the authentication middleware for an in-flight request, and session "s1" is then revoked
      When a second, new request presents session "s1" while the first request is still in flight
      Then the second request's own "Sessions.verify" re-validates from scratch and is rejected
      And the bounded window applies only to the one request that had already passed middleware, never to a second one

  # BEH-EA-055 — spec/behaviors/07-sessions.md
  @BEH-EA-055
  Rule: The session cookie is __Host-session, Secure, HttpOnly, SameSite=Strict, Path=/, with no Domain attribute

    @REQ-EA-154
    Scenario: Issuing a session sets a cookie with the full secure attribute set
      Given a signed-in user "alice"
      When a session is issued for "alice"
      Then the response sets a cookie named "__Host-session"
      And the cookie carries "Secure", "HttpOnly", and "SameSite=Strict"
      And the cookie sets "Path=/"

    @REQ-EA-155
    Scenario: The session cookie never carries a Domain attribute
      Given a signed-in user "alice"
      When a session is issued for "alice"
      Then the cookie sets no "Domain" attribute

    # @skip: describes the browser's own cookie-jar enforcement of the `__Host-` prefix, outside
    # any server-side response test by construction; the server half (the attributes it
    # sets) is asserted by REQ-EA-154/155 and packages/core/test/SessionCookie.test.ts
    @skip
    @REQ-EA-156
    Scenario: A misconfiguration that relaxes a secure attribute makes the cookie fail to be set, not insecurely set
      Given a session cookie configuration that omits "Secure" or adds a "Domain" attribute
      When the browser receives the "__Host-session" cookie
      Then the browser refuses to accept the cookie at all, per the "__Host-" prefix's own enforcement
      And the cookie is never silently accepted with weaker attributes

  # BEH-EA-056 — spec/behaviors/07-sessions.md
  @BEH-EA-056
  Rule: Session-secret verification is a constant-time comparison over a fixed-length hash

    # @skip: a constant-time-comparison mechanism claim with no externally observable outcome
    # a request/response test can tell apart from an ordinary equality check; the observable
    # half (a tampered secret is rejected, the stored digest is not a credential) is REQ-EA-139/140
    # and packages/core/test/Sessions.test.ts "BEH-EA-050/056: a tampered secret is rejected"
    @skip
    @REQ-EA-157
    Scenario: Verifying a presented secret compares its hash against the stored hash using a constant-time check
      Given a session issued for "alice" with secret "s3cr3t"
      When the token is presented for verification
      Then "SHA-256(presented secret)" is compared against the stored hash using a constant-time equality check

    # @skip: a timing-side-channel assertion is not deterministic in CI (same category as
    # password's REQ-EA-306/309); the comparison is the shared Hmac primitive's constant-time
    # equality, covered by packages/core/test/Sessions.test.ts
    @skip
    @REQ-EA-158
    Scenario: Verification timing does not vary with how many leading bytes of the hash match
      Given two presented secrets whose hashes share a different number of leading matching bytes against the stored hash
      When each is presented for verification
      Then the comparison does not short-circuit on the first mismatched byte
      And the comparison time does not vary based on how many leading bytes matched

    # @skip: an internal-mechanism claim (the operands are fixed-length digests) with no
    # externally observable outcome; the digests are asserted fixed-length hex in REQ-EA-138
    @skip
    @REQ-EA-159
    Scenario: The comparison operates over fixed-length hashes regardless of the original secret's length or content
      Given two sessions whose secrets differ in length and content
      When each token is presented for verification
      Then the comparison is performed over the fixed-length "SHA-256" digests of both operands, never over the variable-length secrets themselves
