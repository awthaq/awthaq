# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@http-layer @http-error-mapping
Feature: HTTP Serving and Error Mapping

  # BEH-EA-081 — spec/behaviors/11-http-error-mapping.md; see also
  # ADR-EA-003.
  @BEH-EA-081
  Rule: A plugin's handlers are built with `HttpApiBuilder.group` against its own contract

    @REQ-EA-223
    Scenario: A plugin's handler Layer is built against its own contract and group id
      Given a plugin "Password" declaring its own contract "PasswordContract" and group id "password"
      When "Password"'s handler Layer is built with "HttpApiBuilder.group(PasswordContract, \"password\", ...)"
      Then the handler Layer satisfies exactly the group "password" that "Password" itself declared

    @REQ-EA-224
    Scenario: A plugin's handlers are never built against another plugin's contract or group id
      Given a plugin "Invite" whose own namespace (per BEH-EA-004) entitles it only to group ids it declares itself
      When "Invite"'s handler Layer is built
      Then it is built only against a contract and group id "Invite" itself owns
      And never against "Password"'s or core's contract or group id

  # BEH-EA-082 — spec/behaviors/11-http-error-mapping.md
  @BEH-EA-082
  Rule: A group's service key derives from its group id, so plugin handlers satisfy the merged `AuthApi`

    @REQ-EA-225
    Scenario: A handler Layer built in isolation already satisfies the merged AuthApi's requirement for that group
      Given a plugin "Password" whose handler Layer was built solely against its own contract
      When "Password"'s handler Layer is folded into the merged "AuthApi" produced by "Auth.make"
      Then it already satisfies the service "HttpApiBuilder.layer(auth.api)" requires for the "password" group
      And no additional adaptation of "Password"'s handler Layer is needed

    # Composition is static here: `Auth.make` over the three plugin classes, no layer built (TwoFactor and OAuth need their own stores and providers).
    @REQ-EA-226
    Scenario: This holds regardless of which other plugins are installed alongside it
      Given a plugin "Password" whose handlers were authored before any other plugin was chosen
      When "Password" is composed alongside newly-added plugins "TwoFactor" and "OAuth"
      Then the merged "AuthApi" still declares the "password" group under the service key "Password"'s own handler Layer provides
      And the newly-added plugins' groups sit beside it without displacing it

    @REQ-EA-690
    Scenario: A plugin's group service is unchanged when another plugin is composed alongside it
      Given a plugin "Password" whose handlers were authored before any other plugin was chosen
      When "Password" is composed alongside a newly-added plugin "Invite"
      Then "Password"'s handler Layer continues to satisfy its own group's requirement unchanged

  # BEH-EA-083 — spec/behaviors/11-http-error-mapping.md
  @BEH-EA-083
  Rule: `AuthHttp.routes(auth.api)` registers the composed API with the router

    @REQ-EA-227
    Scenario: AuthHttp.routes accepts the api value produced by Auth.make
      Given an "auth.api" value produced by "Auth.make"
      When "AuthHttp.routes(auth.api)" is called
      Then the composed API's routes are registered with the router

    @REQ-EA-228
    Scenario: AuthHttp.routes accepts Auth.api composing auth groups with application groups
      Given an "auth.api" value produced by "Auth.api" merging awthaq's plugin groups with an application's own groups
      When "AuthHttp.routes(auth.api)" is called
      Then both the awthaq groups and the application's own groups are registered with the router

    @REQ-EA-229
    Scenario: Registering the routes requires no wiring beyond the services auth.layer already provides
      Given the "Routes" Layer produced by "AuthHttp.routes(auth.api)"
      When the services the "Routes" Layer requires ("RIn") are inspected
      Then they are exactly the services "auth.layer" provides, with no additional wiring step

  # BEH-EA-084 — spec/behaviors/11-http-error-mapping.md
  @BEH-EA-084
  Rule: `AuthHttp.docs` serves generated OpenAPI/Scalar documentation from the same contract

    @REQ-EA-230
    Scenario: AuthHttp.docs derives its served documentation from the same auth.api value the router serves
      Given an "auth.api" value provided to both "AuthHttp.routes" and "AuthHttp.docs"
      When a client requests "GET /auth/openapi.json" and "GET /auth/docs"
      Then both are derived entirely from that same "auth.api" value

    @REQ-EA-231
    Scenario: The documentation cannot diverge from the routes actually registered
      Given a plugin group is added to "auth.api"
      When the router and the documentation are both regenerated from the updated "auth.api"
      Then the newly added group appears identically in the registered routes and in the served documentation

  # BEH-EA-085 — spec/behaviors/11-http-error-mapping.md
  @BEH-EA-085
  Rule: `HttpRouter.serve` and `HttpRouter.toWebHandler` are the two designed serving paths for different hosts

    @REQ-EA-232
    Scenario: The composed Routes Layer is served through HttpRouter.serve for an Effect-managed platform server
      Given a composed "Routes" Layer
      When it is served with "HttpRouter.serve(Routes)" provided "NodeHttpServer.layer"
      Then the application is served as a standalone Node server

    @REQ-EA-233
    Scenario: The same composed Routes Layer is served through HttpRouter.toWebHandler without modification
      Given the same composed "Routes" Layer used with "HttpRouter.serve"
      When it is served with "HttpRouter.toWebHandler(Routes)" for a Next.js or Hono host
      Then the host receives a "Request" to "Response" handler with no modification to "Routes" itself

    @REQ-EA-234
    Scenario: Hosting choice does not affect the plugin composition, contract, or handlers
      Given one composed "Routes" Layer built from one plugin composition
      When it is served once via "HttpRouter.serve" and once via "HttpRouter.toWebHandler"
      Then the plugin composition, the contract, and the handlers behave identically in both cases

  # BEH-EA-086 — spec/behaviors/11-http-error-mapping.md
  @BEH-EA-086
  Rule: Error responses are enumeration-safe uniformly across the HTTP surface

    @REQ-EA-235
    Scenario: Sign-in answers identically for an unknown email and a wrong password
      Given an unknown email address "nobody@example.com" and a known user "alice" with a known-wrong password
      When each submits a sign-in request
      Then both responses have the identical status and body, disclosing neither which case occurred

    @REQ-EA-236
    Scenario: Password-reset requests answer identically regardless of whether the target email exists
      Given an email "nobody@example.com" that has no account and an email "alice@example.com" that does
      When each requests a password reset
      Then both responses are "202 Accepted" with identical bodies

    @REQ-EA-237
    Scenario: A third-party plugin's own existence-sensitive endpoint is held to the same uniformity
      Given a third-party plugin exposing an endpoint sensitive to whether an account or token exists
      When the endpoint is requested once for a target that does not exist and once for a target that exists but is otherwise invalid
      Then both responses have the identical status and body

  # BEH-EA-087 — spec/behaviors/11-http-error-mapping.md
  @BEH-EA-087
  Rule: `ManagedRuntime` serves imperative, non-Effect-native code paths against the same Layer

    @REQ-EA-238
    Scenario: An imperative host runs an Effect program against AuthLive via runPromise
      Given a "ManagedRuntime" built with "ManagedRuntime.make(AuthLive)"
      And a Hono route handler not built on "HttpRouter"
      When the handler calls "runtime.runPromise" on a program built against "AuthLive"'s services
      And a valid session resolves a view
      Then the handler returns that view as JSON

    @REQ-EA-239
    Scenario: The same imperative path surfaces an absent session as the host's own 401 response
      Given a "ManagedRuntime" built with "ManagedRuntime.make(AuthLive)"
      And a Hono route handler not built on "HttpRouter"
      When the handler calls "runtime.runPromise" on a program built against "AuthLive"'s services
      And no valid session resolves a view
      Then the handler returns its own "401" response
      And no domain logic is duplicated between this path and the HttpRouter-based serving paths

  # BEH-EA-088 — spec/behaviors/11-http-error-mapping.md; see also
  # ADR-EA-013.
  @BEH-EA-088
  Rule: Every contract error's HTTP status is derived from its `httpApiStatus` annotation, uniformly

    @REQ-EA-240
    Scenario Outline: The observed HTTP status matches the failing error's own httpApiStatus annotation
      Given a handler fails with the "<error>" tagged error
      When the response is served
      Then the client observes "<status>"

      Examples:
        | error              | status           |
        | Unauthenticated    | 401 Unauthorized |
        | InvalidCredentials | 401 Unauthorized |
        | CsrfRejected       | 403 Forbidden    |
        # MA-004/ADR-EA-028: an unavailable backing store is a typed, retryable outage, not a 401 or a 500.
        | StoreUnavailable   | 503 Service Unavailable |

    @REQ-EA-241
    Scenario: No separate, out-of-band status-mapping table is maintained anywhere in the HTTP stratum
      Given two different contract errors declared with two different httpApiStatus annotations
      When the HTTP stratum serves responses for both
      Then each response's status is read solely from that error's own annotation
      And no switch statement or lookup table mapping error tags to statuses exists anywhere in the HTTP-serving code
