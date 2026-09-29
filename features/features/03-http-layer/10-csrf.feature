# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@http-layer @csrf
Feature: CSRF Protection

  # BEH-EA-073 — spec/behaviors/10-csrf.md
  @BEH-EA-073
  Rule: `Sec-Fetch-Site` is the primary CSRF signal

    @REQ-EA-204
    Scenario: A same-origin unsafe request with Sec-Fetch-Site present passes the first-signal check
      Given an unsafe "POST" request carrying "Sec-Fetch-Site: same-origin"
      When "CsrfProtection" evaluates the request
      Then the request passes the "Sec-Fetch-Site" check

    @REQ-EA-205
    Scenario: A cross-site unsafe request is rejected on the Sec-Fetch-Site signal alone
      Given an unsafe "POST" request carrying "Sec-Fetch-Site: cross-site"
      When "CsrfProtection" evaluates the request
      Then the request is rejected
      And the rejection is decided before any other CSRF check runs

    @REQ-EA-206
    Scenario: A Sec-Fetch-Site rejection short-circuits the Origin and double-submit checks
      Given an unsafe "POST" request carrying "Sec-Fetch-Site: cross-site"
      When "CsrfProtection" evaluates the request
      Then neither the "Origin" comparison nor the double-submit cookie check is evaluated

  # BEH-EA-074 — spec/behaviors/10-csrf.md
  @BEH-EA-074
  Rule: `Origin` is the fallback signal when `Sec-Fetch-Site` is absent

    @REQ-EA-207
    Scenario: An unsafe request with no Sec-Fetch-Site header and a matching Origin passes
      Given an unsafe "POST" request with no "Sec-Fetch-Site" header and an "Origin" header matching the application's configured allowed origins
      When "CsrfProtection" evaluates the request
      Then the request passes the "Origin" fallback check

    @REQ-EA-208
    Scenario: An unsafe request with no Sec-Fetch-Site header and a mismatched Origin is rejected
      Given an unsafe "POST" request with no "Sec-Fetch-Site" header and an "Origin" header that does not match the application's configured allowed origins
      When "CsrfProtection" evaluates the request
      Then the request is rejected

    @REQ-EA-209
    Scenario: The Origin fallback is not consulted when Sec-Fetch-Site is present
      Given an unsafe "POST" request carrying "Sec-Fetch-Site: same-origin" and an "Origin" header that would fail the fallback comparison
      When "CsrfProtection" evaluates the request
      Then the request passes on the "Sec-Fetch-Site" signal
      And the "Origin" header is never compared

  # BEH-EA-075 — spec/behaviors/10-csrf.md
  @BEH-EA-075
  Rule: A signed double-submit `__Host-csrf` cookie backs the header-based check

    @REQ-EA-210
    Scenario: A request echoing the signed cookie's token in the header passes
      Given a signed "__Host-csrf" cookie was issued to the client
      And an unsafe "POST" request echoes that cookie's token in the "x-csrf-token" header
      When "CsrfProtection" evaluates the request
      Then the request passes the double-submit check

    @REQ-EA-211
    Scenario: A request missing the x-csrf-token header is rejected
      Given a signed "__Host-csrf" cookie was issued to the client
      And an unsafe "POST" request carries no "x-csrf-token" header
      When "CsrfProtection" evaluates the request
      Then the request is rejected

    @REQ-EA-212
    Scenario: A request with a header value that does not match the signed cookie is rejected
      Given a signed "__Host-csrf" cookie was issued to the client
      And an unsafe "POST" request carries an "x-csrf-token" header that does not match the cookie's token
      When "CsrfProtection" evaluates the request
      Then the request is rejected

    @REQ-EA-213
    Scenario: A request presenting a tampered or unsigned cookie value is rejected
      Given a "__Host-csrf" cookie whose signature does not verify
      And an unsafe "POST" request echoes that cookie's token value in the "x-csrf-token" header
      When "CsrfProtection" evaluates the request
      Then the request is rejected

  # BEH-EA-076 — spec/behaviors/10-csrf.md; see also INV-EA-011.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler, not a runtime step. The type-level assertions live in
  # features/step-definitions/CsrfClientTypes.ts and are checked by `tsc`
  # (the `typecheck` gate); the Then steps here read them, and REQ-EA-214
  # also drives a real call through the client the type describes.
  @BEH-EA-076 @compile-time
  Rule: `requiredForClient: true` is enforced at the type level, not merely documented

    @REQ-EA-214
    Scenario: Supplying the CSRF client layer produces a usable, type-checking client
      Given a contract group carrying "CsrfProtection"
      When an "HttpApiClient"/"AtomHttpApi.Service" is built with "HttpApiMiddleware.layerClient(CsrfProtection, ...)" supplied
      Then the client build type-checks and produces a usable client

    @REQ-EA-215
    Scenario: Omitting the CSRF client layer fails the client build at compile time
      Given a contract group carrying "CsrfProtection"
      When an "HttpApiClient"/"AtomHttpApi.Service" is built without "HttpApiMiddleware.layerClient(CsrfProtection, ...)" supplied
      Then the client build fails to type-check
      And the failure names "ForClient<CsrfProtection>" as still required

  # BEH-EA-077 — spec/behaviors/10-csrf.md
  @BEH-EA-077
  Rule: Only unsafe methods are protected; safe methods are exempt by construction

    @REQ-EA-216
    Scenario Outline: CSRF checks apply only to unsafe methods
      Given a request using the "<method>" method with no CSRF header, no double-submit cookie, and no Sec-Fetch-Site header
      When "CsrfProtection" evaluates the request
      Then the request is "<outcome>"

      Examples:
        | method | outcome                  |
        | GET    | not subject to rejection |
        | HEAD   | not subject to rejection |
        | POST   | rejected                 |
        | PUT    | rejected                 |
        | PATCH  | rejected                 |
        | DELETE | rejected                 |

  # BEH-EA-078 — spec/behaviors/10-csrf.md
  @BEH-EA-078
  Rule: A rejected CSRF check fails with a typed `CsrfRejected` error at `403`

    @REQ-EA-217
    Scenario Outline: Every CSRF rejection reason produces the same typed error and status
      Given an unsafe "POST" request that fails the "<check>" check
      When "CsrfProtection" evaluates the request
      Then the request fails with a typed "CsrfRejected" error
      And the response is "403 Forbidden"

      Examples:
        | check                  |
        | Sec-Fetch-Site         |
        | Origin fallback        |
        | double-submit cookie   |

    @REQ-EA-218
    Scenario: CsrfRejected is uniform across every group the middleware protects
      Given two different groups, "app" and "billing", both carrying "CsrfProtection"
      When a request to each group fails a CSRF check
      Then both requests fail with the identical "CsrfRejected" error annotated "403"

  # BEH-EA-079 — spec/behaviors/10-csrf.md
  @BEH-EA-079
  Rule: A client may opt out of CSRF by choosing a bearer-only contract variant

    # @skip: superseded (PV-262): `Auth.api(..., { csrf: false })` is not built (packages/client/src/AuthClient.ts
    # header; decision 24 chose the Authorization-header exemption below instead, MNA-008); the shipped
    # behavior is REQ-EA-689 and packages/server/test/Csrf.test.ts (bearer POST).
    @skip
    @REQ-EA-219
    Scenario: Requests against the csrf:false contract succeed on unsafe methods with no CSRF header at all
      Given a native client built against "Auth.api(..., { csrf: false })"
      When the client sends an unsafe "POST" request with no CSRF header and no double-submit cookie
      Then the request succeeds without any CSRF check being applied

    # @skip: superseded with REQ-EA-219 (PV-262): there is no `csrf: false` contract to inspect.
    @skip
    @REQ-EA-220
    Scenario: The csrf:false contract's groups carry no CsrfProtection middleware at all
      Given a contract produced by "Auth.api(..., { csrf: false })"
      When the contract's groups are inspected
      Then none of them declare the "CsrfProtection" middleware
      And this is a structural absence from the contract, not a runtime flag that skips an otherwise-declared check

    # MNA-008/decision 24 §2: what shipped for native clients — a request carrying an
    # Authorization header is exempt from CSRF minting and enforcement alike.
    @REQ-EA-689
    Scenario: An unsafe request carrying an Authorization header needs no CSRF pair
      Given a native client with a bearer token and no cookie jar
      When it sends an unsafe "POST" request carrying an "Authorization" header and no CSRF header or double-submit cookie
      Then the request passes without any CSRF check being applied to it, and no "__Host-csrf" cookie is minted for it
      And an unsafe "POST" request with an empty "Authorization" header and no CSRF pair is still rejected

  # BEH-EA-080 — spec/behaviors/10-csrf.md
  @BEH-EA-080
  Rule: The CSRF cookie name and header name are fixed, not per-plugin configurable

    @REQ-EA-221
    Scenario: Every application composed through Auth.make uses the same fixed cookie and header names
      Given two different applications composed through "Auth.make" with different installed plugins
      When each application's "CsrfProtection" middleware is inspected
      Then both use the cookie name "__Host-csrf" and the header name "x-csrf-token"

    @REQ-EA-222
    Scenario: No plugin or configuration can rename the CSRF cookie or header
      Given an application composed through "Auth.make"
      When a plugin or application configuration attempts to override the CSRF cookie or header name
      Then no such override is available, since "__Host-csrf" and "x-csrf-token" are fixed for every application
