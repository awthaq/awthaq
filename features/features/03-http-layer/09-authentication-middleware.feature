# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@http-layer @authentication-middleware
@skip @unwired
Feature: Authentication Middleware

  # BEH-EA-065 — spec/behaviors/09-authentication-middleware.md; see also
  # ADR-EA-003.
  @BEH-EA-065
  Rule: The `Authentication` middleware tries a cookie handler first, in its declared security record

    @REQ-EA-185
    Scenario: A request carrying a valid session cookie resolves via the cookie handler
      Given a signed-in user "alice" with a live, unexpired session cookie "__Host-session"
      And the "Authentication" middleware's security record declares "cookie" before "bearer"
      When "alice" sends a request under "Authentication" carrying only the session cookie
      Then the request resolves to "alice"'s session via the cookie handler
      And the bearer handler is never attempted

    @REQ-EA-186
    Scenario: A request carrying both a valid cookie and a bearer token is resolved by the cookie handler first
      Given a signed-in user "alice" with a live, unexpired session cookie "__Host-session"
      And "alice" also presents an "Authorization: Bearer <token>" header on the same request
      When "alice" sends the request under "Authentication"
      Then the cookie handler resolves the session before the bearer handler is attempted
      And the bearer handler is not consulted because the cookie handler already succeeded

  # BEH-EA-066 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-066
  Rule: The bearer handler is tried after the cookie handler fails, over the same session-resolution logic

    @REQ-EA-187
    Scenario: A native client presenting a bearer token is resolved to the same Principal shape a cookie would produce
      Given a signed-in user "alice" whose session token is presented as "Authorization: Bearer <token>" with no cookie jar
      When "alice"'s native client sends a request under "Authentication"
      Then the bearer handler resolves the same session through the shared "Sessions"/"PrincipalResolver" path the cookie handler uses
      And the resulting Principal has the same shape as if "alice" had presented the equivalent session cookie

    @REQ-EA-188
    Scenario: The bearer handler is only attempted once the cookie handler has failed
      Given a request under "Authentication" carrying no session cookie but a valid bearer token
      When the request is authenticated
      Then the cookie handler fails to resolve a session first
      And the bearer handler is then tried and resolves the session

  # BEH-EA-067 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-067
  Rule: When no scheme succeeds under required authentication, the request fails Unauthenticated

    @REQ-EA-189
    Scenario: A request with neither a valid cookie nor a valid bearer token fails before any handler code runs
      Given a request under a group carrying "Authentication" with no session cookie and no bearer token
      When the request is processed
      Then the request fails with a typed "Unauthenticated" error
      And the response is "401 Unauthenticated"
      And no handler code for the endpoint runs

    @REQ-EA-190
    Scenario: An expired session cookie and no bearer token still fails Unauthenticated
      Given a request under a group carrying "Authentication" presenting an expired session cookie and no bearer token
      When the request is processed
      Then both the cookie handler and the bearer handler fail to resolve a session
      And the request fails with a typed "Unauthenticated" error

  # BEH-EA-068 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-068
  Rule: `OptionalAuthentication` resolves to `CurrentPrincipal = AnonymousPrincipal` rather than failing

    @REQ-EA-191
    Scenario: A request with no credential under OptionalAuthentication proceeds with an anonymous principal
      Given a request under a group carrying "OptionalAuthentication" with no session cookie and no bearer token
      When the request is processed
      Then the request is not failed
      And "CurrentPrincipal" is provided to the handler as "AnonymousPrincipal"

    @REQ-EA-192
    Scenario: A request with an invalid credential under OptionalAuthentication still resolves anonymously rather than failing
      Given a request under a group carrying "OptionalAuthentication" presenting an expired session cookie
      When the request is processed
      Then the request is not failed
      And "CurrentPrincipal" is provided to the handler as "AnonymousPrincipal"

    @REQ-EA-193
    Scenario: A request with a valid credential under OptionalAuthentication resolves identically to Authentication's own resolution
      Given a signed-in user "alice" with a live, unexpired session cookie
      When "alice" sends a request under a group carrying "OptionalAuthentication"
      Then "CurrentPrincipal" is provided to the handler as "alice"'s resolved Principal
      And the resolution logic used is the same one "Authentication" uses for a present credential

  # BEH-EA-069 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-069
  Rule: `PrincipalResolver` maps a verified session to a `Principal` value

    @REQ-EA-194
    Scenario: PrincipalResolver derives a Principal from a resolved session
      Given a resolved, live "Session" for "alice"
      When "PrincipalResolver" resolves the session
      Then a "Principal" value is produced for "alice"

    @REQ-EA-195
    Scenario: PrincipalResolver derives a Principal from a bearer/API-key credential
      Given a resolved bearer credential that identifies a service caller
      When "PrincipalResolver" resolves the credential
      Then a "Principal" value is produced for that service caller

    @REQ-EA-196
    Scenario: PrincipalResolver performs no authorization decision while deriving a Principal
      Given a resolved, live "Session" for "alice"
      When "PrincipalResolver" resolves the session
      Then only a "Principal" is produced
      And no authorization decision is made, since that responsibility belongs to qadi's "SubjectResolver" downstream

  # BEH-EA-070 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-070
  Rule: `CurrentPrincipal` is provided by `Authentication`/`OptionalAuthentication` and consumed by handlers as an ordinary service

    @REQ-EA-197
    Scenario: A handler under Authentication reads CurrentPrincipal as an ordinary service dependency
      Given a signed-in user "alice" authenticated under a group carrying "Authentication"
      When "alice"'s handler runs and reads "CurrentPrincipal"
      Then the handler receives "alice"'s Principal via an ordinary service read, with no second mechanism involved

    @REQ-EA-198
    Scenario: A handler in a group declaring neither Authentication nor OptionalAuthentication has no CurrentPrincipal available
      Given a group that carries neither "Authentication" nor "OptionalAuthentication"
      When a handler in that group is built
      Then "CurrentPrincipal" is not present in that handler's available context

  # BEH-EA-071 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-071
  Rule: Different groups may select different authentication schemes

    @REQ-EA-199
    Scenario: A machine-to-machine group under ApiKeyAuthentication resolves a ServicePrincipal
      Given a group "machine" carrying "ApiKeyAuthentication"
      When a request presents a valid "x-api-key" header to the "machine" group
      Then the request resolves to a "ServicePrincipal"

    @REQ-EA-200
    Scenario: An application group under Authentication resolves the ordinary Principal union
      Given a group "app" carrying "Authentication"
      When a signed-in user "alice" requests an endpoint in the "app" group
      Then the request resolves to the ordinary Principal union "Authentication" produces

    @REQ-EA-201
    Scenario: Two groups with different authentication middleware compose independently in one contract
      Given a composed contract containing group "machine" under "ApiKeyAuthentication" and group "app" under "Authentication"
      When each group's requests are authenticated
      Then "machine"'s scheme selection has no effect on how "app"'s requests are authenticated, and vice versa

  # BEH-EA-072 — spec/behaviors/09-authentication-middleware.md
  @BEH-EA-072
  Rule: The security record's declaration order is the entire strategy chain — no separate ordering mechanism exists

    @REQ-EA-202
    Scenario: There is no configuration, priority number, or runtime flag that reorders scheme trial order
      Given the "Authentication" middleware's declared security record "{ cookie: SessionCookie, bearer: BearerToken }"
      When the application is configured in any way other than editing that record
      Then no configuration, priority number, or runtime flag changes which scheme is tried first

    @REQ-EA-203
    Scenario: Reordering the declared record itself changes the try-order
      Given the "Authentication" middleware's security record is redeclared as "{ bearer: BearerToken, cookie: SessionCookie }"
      When a request presenting both a valid bearer token and a valid session cookie is authenticated
      Then the bearer handler is tried first
      And the try-order changed only because the declaration itself changed
