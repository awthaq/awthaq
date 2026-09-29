# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@client-integration @effect-client
Feature: The Effect Client

  # BEH-EA-169 — spec/behaviors/22-client-effect.md; see also ADR-EA-003
  @BEH-EA-169
  Rule: The client derives from the merged contract

    @REQ-EA-476
    Scenario: HttpApiClient.make derives every endpoint method from the merged AuthApi contract
      Given a merged "AuthApi" contract containing groups from "Password" and "Sessions"
      When "HttpApiClient.make" builds a client against "AuthApi"
      Then the client exposes a method for every endpoint declared in "AuthApi"
      And no method is defined outside what "AuthApi" declares

    @REQ-EA-477
    Scenario: The reactive binding derives its endpoints from the same merged contract
      Given a merged "AuthApi" contract containing groups from "Password" and "Sessions"
      When "AtomHttpApi.Service" builds the reactive client against "AuthApi"
      Then the reactive client exposes the same set of endpoint methods that "HttpApiClient.make" produces for "AuthApi"

    @REQ-EA-478
    Scenario: A new endpoint added to the contract appears on the client without hand-written code
      Given a plugin adds a new endpoint to its "HttpApiGroup" in "AuthApi"
      When "HttpApiClient.make" rebuilds the client against the updated "AuthApi"
      Then the client exposes a method for the new endpoint
      And no hand-written method was added to produce it, so the contract and the client cannot drift apart

  # BEH-EA-170 — spec/behaviors/22-client-effect.md; see also INV-EA-011
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (the client's own Effect requirement type), not a runtime step.
  # These scenarios record the intended developer-facing outcome; the
  # eventual verification artifact is a type-level test
  # (definitions-of-done.md gate 5).
  @BEH-EA-170 @compile-time
  Rule: CsrfProtection is required by the client type

    @REQ-EA-479
    Scenario: A cookie-mode client program providing the CsrfClient layer type-checks
      Given a cookie-mode client program that provides "CsrfClient" as its "CsrfProtection" client middleware Layer
      When the program is type-checked
      Then composition succeeds

    @REQ-EA-480
    Scenario: Omitting the CsrfClient layer fails to type-check, naming the missing requirement
      Given a cookie-mode client program with the "CsrfClient" layer removed from its provided Layers
      When the program is type-checked
      Then it fails to type-check
      And the diagnostic names "ForClient<CsrfProtection>" as the unsatisfied requirement

    @REQ-EA-481
    Scenario: The omission is caught at compile time, never surfacing later as a runtime 403
      Given a cookie-mode client program with the "CsrfClient" layer removed from its provided Layers
      When the program is type-checked
      Then the gap is reported as a compile-time failure
      And no runtime request against a live server is needed to discover it as a 403 in production

  # BEH-EA-171 — spec/behaviors/22-client-effect.md. Retired (PV-262, decision 24 / MNA-008): the
  # { csrf: false } contract variant this behavior described is not built, so its Rule has no scenarios
  # left (REQ-EA-482..484 were removed). What shipped instead: the bearer exemption is server-side
  # (REQ-EA-689 in 10-csrf.feature) and a bearer client attaches its token through transformClient
  # (REQ-EA-495 below).

  # BEH-EA-172 — spec/behaviors/22-client-effect.md
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (AuthErrorCode's derivation from the compiled AuthApi type and
  # the catalog's `satisfies` check), not a runtime step. These scenarios
  # record the intended developer-facing outcome; the eventual verification
  # artifact is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-172 @compile-time
  Rule: Error codes are derived from the contract

    @REQ-EA-485
    Scenario: AuthErrorCode is derived mechanically from the compiled AuthApi's declared error tags
      Given a compiled "AuthApi" whose plugins declare typed errors "InvalidCredentials" and "RateLimited"
      When the type "AuthClient.ErrorCodes<typeof AuthApi>" is computed
      Then it is the union "InvalidCredentials" | "RateLimited"

    @REQ-EA-486
    Scenario: Adding a new typed error to a plugin's contract extends AuthErrorCode without a hand-maintained list
      Given a plugin adds a new "Schema.TaggedError" to its contract
      When "AuthClient.ErrorCodes<typeof AuthApi>" is recomputed
      Then the new error tag is included in the type automatically
      And no separate hand-maintained list of error codes was updated to include it

    @REQ-EA-487
    Scenario: An untranslated new error tag fails to type-check against the i18n catalog's declared shape
      Given an i18n "messages" catalog declared as "satisfies Record<AuthErrorCode, string>"
      And a contract change adds a new error tag the catalog has not yet translated
      When the catalog is type-checked against the updated "AuthErrorCode"
      Then it fails to type-check

  # BEH-EA-173 — spec/behaviors/22-client-effect.md
  @BEH-EA-173
  Rule: urlBuilder for typed redirect links

    @REQ-EA-488
    Scenario: urlBuilder generates the OAuth authorize link from the same contract as the request-issuing client
      Given the merged "AuthApi" contract declares an "oauth.authorize" endpoint
      When "HttpApiClient.urlBuilder(AuthApi).oauth.authorize" is called with params "{ provider: \"google\" }" and query "{ callbackURL: \"/dashboard\" }"
      Then the returned URL correctly encodes the "provider" path parameter and the "callbackURL" query parameter

    @REQ-EA-489
    Scenario: A parameter that would fail schema encoding in a real request fails the same way through urlBuilder
      Given a parameter value that does not satisfy the "oauth.authorize" endpoint's declared "Schema"
      When the same value is passed to a real request call and separately to "urlBuilder" for "oauth.authorize"
      Then both fail encoding in the same way

    @REQ-EA-490
    Scenario: A redirect value containing characters unsafe for hand string concatenation is correctly encoded by urlBuilder
      Given a "callbackURL" query value containing characters that would corrupt a hand-concatenated URL, such as "&" and "?"
      When the "unsubscribe" link is built with "urlBuilder" against the contract
      Then the returned URL correctly percent-encodes those characters
      And the link is not assembled by string-concatenating a path and query parameters by hand

  # BEH-EA-174 — spec/behaviors/22-client-effect.md
  @BEH-EA-174
  Rule: Session helpers are the hand-written remainder

    @REQ-EA-491
    Scenario: Reading the current session via session.get returns the store's current value
      Given a client session store holding "Session | null"
      When application code calls "authClient.session.get()"
      Then it returns the store's current value without issuing an additional network request

    @REQ-EA-492
    Scenario: Hydrating the session store with a non-null initial session seeds it for SSR
      Given a client session store with no value yet set
      When "authClient.session.hydrate(initialSession)" is called with a non-null "initialSession"
      Then the store's current value becomes "initialSession"

    @REQ-EA-493
    Scenario: A later hydrate call does not overwrite an already-seeded non-null session
      Given a client session store already seeded with a non-null session via "hydrate"
      When "authClient.session.hydrate(otherSession)" is called afterward
      Then the store's current value remains the original non-null session, because the first non-null value wins

    @REQ-EA-494
    Scenario: The hand-written client surface contains no re-implementation of a generated endpoint method
      Given the hand-written portion of "@awthaq/client" — the session store, CSRF header injection, and the credentials/bearer policy
      When that hand-written surface is compared against the endpoints "HttpApiClient" derives from "AuthApi"
      Then no hand-written method duplicates an endpoint method the generated client already provides

  # BEH-EA-175 — spec/behaviors/22-client-effect.md
  @BEH-EA-175
  Rule: transformClient is the one seam for custom auth policy

    @REQ-EA-495
    Scenario: Attaching a keychain token via transformClient adds it to every outgoing request
      Given a native client configured with "transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token))"
      When any generated endpoint method issues a request
      Then the request carries the bearer token attached by "transformClient"

    @REQ-EA-496
    Scenario: transformClient composes with the CSRF middleware seam rather than replacing it
      Given a cookie-mode client providing both "CsrfClient" and an application-supplied "transformClient"
      When a request is issued
      Then the request carries both the CSRF header from "CsrfClient" and the modification from the application's "transformClient"

    @REQ-EA-497
    Scenario: A custom cross-cutting client policy is not implemented by wrapping or re-exporting a generated method
      Given an application needs to attach a tenant header to every outgoing request
      When that policy is implemented
      Then it is expressed through "transformClient"/"transformResponse"
      And no generated per-endpoint method is wrapped, shadowed, or re-exported to implement it

  # BEH-EA-176 — spec/behaviors/22-client-effect.md
  @BEH-EA-176
  Rule: A Promise facade is opt-in, never a second client

    @REQ-EA-498
    Scenario: A Promise-facade call resolves through the same underlying client and evaluator as the Effect-native call
      Given a Promise-returning wrapper "AuthClient.toPromiseFacade(client)" built for non-Effect callers
      When "facade.session.signOut()" is called through the wrapper
      Then the call is dispatched through the same underlying client and the same generated method the Effect-native client uses

    @REQ-EA-499
    Scenario: An Effect caller and a Promise-facade caller invoking the same operation observe identical behavior
      Given the same operation evaluated once via the Effect-native client and once via the Promise facade
      When both calls complete
      Then both report the same decision, because neither is a separately implemented evaluation path

    @REQ-EA-500
    Scenario: The Promise facade contains no separately implemented request or decision logic of its own
      Given the Promise facade offered for non-Effect code
      When its implementation is inspected
      Then it is a thin "Effect.runPromise" shim over the one generated client
      And it defines no independent request construction or decision logic
