# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

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

    # Rewritten to what shipped (BEH-EA-053 as-shipped): the confirmation has no session of its own to rotate, so it ends every session of the account.
    @REQ-EA-686
    Scenario: An email change ends the account's sessions, because its confirmation has no session to rotate
      Given a signed-in user "alice" with session "s0"
      When "alice" performs a "email change"
      Then session "s0" no longer verifies
      And "alice" signs in afresh under the new address

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
    @REQ-EA-687
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

    # The mechanism has no request/response signature, so it is pinned at its two ends: Sessions.ts verifies only through SecretHash.equals, which is Hmac.constantTimeEqualString.
    @REQ-EA-157
    Scenario: Verifying a presented secret compares its hash against the stored hash using a constant-time check
      Given a session issued for "alice" with secret "s3cr3t"
      When the token is presented for verification
      Then "SHA-256(presented secret)" is compared against the stored hash using a constant-time equality check

    # Work, not wall-clock time: the comparator is fed array-likes that count every element read, so "does not short-circuit" is a deterministic count rather than a timing measurement.
    @REQ-EA-158
    Scenario: Verification timing does not vary with how many leading bytes of the hash match
      Given two presented secrets whose hashes share a different number of leading matching bytes against the stored hash
      When each is presented for verification
      Then the comparison does not short-circuit on the first mismatched byte
      And the comparison does the same work however many leading bytes matched

    # Observed through its consequence: a comparison over raw variable-length secrets would trip on a length mismatch, so any presented length is refused the same way.
    @REQ-EA-159
    Scenario: The comparison operates over fixed-length hashes regardless of the original secret's length or content
      Given a signed-in user "alice"
      When secrets of 1, 64 and 4096 characters are presented under "alice"'s session id
      Then each is refused as unauthenticated, never as a server error
      And the stored digest keeps its fixed 64-hex length, so the comparison is over digests and never over the presented secrets themselves

  # BEH-EA-258 — spec/behaviors/07-sessions.md; see also ADR-EA-021, ADR-EA-012
  @BEH-EA-258
  Rule: A session's authentication facts reach the policy layer as attributes

    @REQ-EA-995
    Scenario Outline: The assurance level is derived from the recorded methods and never guessed stronger
      When the assurance of a session that recorded "<methods>" is derived
      Then its level is "<level>" and its restricted-factor flag is "<restricted>"

      Examples:
        | methods     | level | restricted |
        | none        | aal1  | false      |
        | pwd         | aal1  | false      |
        | fed         | aal1  | false      |
        | otp,email   | aal1  | false      |
        | hwk         | aal1  | false      |
        | sms         | aal1  | true       |
        | pwd,otp,mfa | aal2  | false      |
        | pwd,sms     | aal2  | true       |
        | hwk,user    | aal3  | false      |

    @REQ-EA-996
    Scenario: A restricted factor is left out of a level check unless the caller opts in
      When the assurance of a session that recorded "pwd,sms" is derived
      Then it satisfies "aal2" only when restricted factors are allowed

    @REQ-EA-997
    Scenario: The resolved principal carries the session's amr and authenticatedAt
      Given a signed-in user "alice"
      And a session is issued for "alice" that recorded "pwd,otp,mfa"
      When the principal of that session is resolved
      Then the principal carries the methods "pwd,otp,mfa" and the session's authentication time in epoch seconds

    @REQ-EA-998
    Scenario: The default subject places amr, authenticatedAt, aal and restrictedFactor on its attributes
      Given a signed-in user "alice"
      And a session is issued for "alice" that recorded "pwd,otp,mfa"
      When the principal of that session is resolved
      Then the default subject holds the methods "pwd,otp,mfa", the authentication time, the level "aal2" and the restricted-factor flag "false"

    @REQ-EA-999
    Scenario: A session that recorded no methods carries an empty amr and the aal1 floor
      Given a signed-in user "alice"
      And a session is issued for "alice" that recorded "none"
      When the principal of that session is resolved
      Then the default subject holds the methods "none", the authentication time, the level "aal1" and the restricted-factor flag "false"

    # The principal comes from a real session that recorded the methods; the token is minted by the real @awthaq/jwt (JwtSigner in SessionAssuranceSteps).
    @REQ-EA-1000
    Scenario: A principal JWT carries amr and auth_time when the session recorded them
      Given a signed-in user "alice"
      And a session is issued for "alice" that recorded "pwd,otp,mfa"
      When a principal token is minted for that session
      Then the token carries "amr" and "auth_time" of that session
