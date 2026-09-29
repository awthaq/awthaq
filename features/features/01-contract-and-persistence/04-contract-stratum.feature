@foundations @contract
Feature: The Contract Stratum

  # BEH-EA-025 — spec/behaviors/04-contract-stratum.md; see also ADR-EA-003
  @BEH-EA-025
  Rule: A Principal is a tagged union carrying a Zanzibar-shaped reference

    @REQ-EA-059
    Scenario Outline: Each declared principal kind decodes and encodes through the Principal union
      Given a "<tag>" principal value carrying a PrincipalRef with a type and an id
      When the value is encoded and then decoded against the Principal schema
      Then the round-trip succeeds and the decoded value's tag is still "<tag>"

      Examples:
        | tag        |
        | User       |
        | ApiKey     |
        | Service    |
        | Anonymous  |

    @REQ-EA-060
    Scenario: A payload carrying an undeclared principal tag is rejected
      Given a payload whose "_tag" is not one of "User", "ApiKey", "Service", or "Anonymous"
      When the payload is decoded against the Principal schema
      Then decoding fails
      And no principal kind is reachable except through one of the declared tags

    @REQ-EA-061
    Scenario: A UserPrincipal's actingAs reference carries a second identity without a fifth principal kind
      Given a UserPrincipal for a signed-in user "alice" impersonating another PrincipalRef
      When the principal is decoded
      Then "alice"'s UserPrincipal carries the impersonated reference in its actingAs field
      And the impersonated identity is represented without introducing a new principal tag

  # BEH-EA-026 — spec/behaviors/04-contract-stratum.md
  @BEH-EA-026
  Rule: SessionView and SubjectDto are the wire shapes of "who is signed in and what they may do"

    # @skip: the combined SessionView struct (principal + user + session + subject) is not shipped: sign-in, sign-up and GET /session return SessionDto, and the subject is its own GET /subject atom (packages/api/src/Subject.ts header); blocked by PV-250
    @skip
    @REQ-EA-062
    Scenario: SessionView bundles principal, user, session, and subject in one struct
      Given a signed-in user "alice" with a valid session
      When a SessionView is produced for "alice"
      Then the SessionView carries "principal", "user", "session", and "subject" as one struct

    # @skip: SubjectDto's mapper from AuthSubject is module-private to @awthaq/qadi and only reachable through the served GET /subject; covered by packages/qadi/test/SubjectApi.test.ts ("an exposed resolver-backed attribute appears in GET /subject", decoding the SubjectDto)
    @skip
    @REQ-EA-063
    Scenario: SubjectDto flattens qadi's AuthSubject into wire-safe arrays
      Given qadi's AuthSubject for a signed-in user "alice" carries roles and permissions
      When the SubjectDto for "alice" is produced
      Then the SubjectDto's "roles" and "permissions" are each a flat array suitable for serialization
      And the SubjectDto carries an "attributes" record alongside them

    # @skip: sign-in, sign-up and GET /session do not return one SessionView shape (they return SessionDto; the subject is a separate contract); blocked by PV-250
    @skip
    @REQ-EA-064
    Scenario: Sign-in, sign-up, and GET /auth/session return the same SessionView shape
      Given a signed-in user "alice"
      When "alice" signs in, and separately when a new user signs up, and separately when "alice" requests GET /auth/session
      Then all three responses are shaped as the same SessionView struct

  # BEH-EA-027 — spec/behaviors/04-contract-stratum.md
  @BEH-EA-027
  Rule: Every contract error is a Schema.TaggedError carrying its own httpApiStatus, and credential errors are enumeration-safe

    @REQ-EA-065
    Scenario: A contract error is declared as a Schema.TaggedError annotated with its own httpApiStatus
      Given the "InvalidCredentials" contract error
      When a handler returns "InvalidCredentials" as a failure
      Then the response status is the error's own declared "401" httpApiStatus

    @REQ-EA-066
    Scenario: A non-existent email and a wrong password produce the identical credential error
      Given a sign-in attempt with an email that does not exist in the system
      And a separate sign-in attempt with an email that exists but the wrong password
      When both attempts are submitted
      Then both attempts fail with the identical "InvalidCredentials" error and status

    @REQ-EA-067
    Scenario: The credential error does not disclose whether the submitted email exists
      Given a sign-in attempt with an email that does not exist in the system
      When the attempt is submitted
      Then the response is indistinguishable from a wrong-password response for an existing email
      And no observable difference discloses account existence

    @REQ-EA-068
    Scenario: Distinct contract errors remain distinct typed failures
      Given the "InvalidCredentials" and "Unauthenticated" contract errors
      When a handler catches failures by error tag
      Then catching "InvalidCredentials" does not also catch "Unauthenticated"

  # BEH-EA-028 — spec/behaviors/04-contract-stratum.md
  @BEH-EA-028
  Rule: Authentication is a single multi-scheme middleware tried in declaration order

    @REQ-EA-069
    Scenario: The first declared scheme that succeeds is used
      Given the Authentication middleware's security record declares "cookie" before "bearer"
      And a request carries both a valid session cookie and a valid bearer token
      When the request is authenticated
      Then the cookie scheme resolves the principal
      And the bearer scheme is never tried

    @REQ-EA-070
    Scenario: A later declared scheme is tried when an earlier one does not succeed
      Given the Authentication middleware's security record declares "cookie" before "bearer"
      And a request carries no session cookie but a valid bearer token
      When the request is authenticated
      Then the bearer scheme resolves the principal

    @REQ-EA-071
    Scenario: Authentication fails when no declared scheme succeeds
      Given the Authentication middleware's security record declares "cookie" before "bearer"
      And a request carries neither a valid session cookie nor a valid bearer token
      When the request is authenticated
      Then authentication fails

    @REQ-EA-072
    Scenario: The security record's declared key order is the only ordering mechanism
      Given the Authentication middleware's security record declares "bearer" before "cookie"
      And a request carries both a valid session cookie and a valid bearer token
      When the request is authenticated
      Then the bearer scheme resolves the principal
      And no separate ordering configuration overrides the record's declared key order

  # BEH-EA-029 — spec/behaviors/04-contract-stratum.md
  @BEH-EA-029
  Rule: OptionalAuthentication yields an AnonymousPrincipal instead of failing

    @REQ-EA-073
    Scenario: A request with no credential under OptionalAuthentication resolves to AnonymousPrincipal
      Given a group of endpoints under "OptionalAuthentication"
      And a request with no session cookie and no bearer token
      When the request reaches the handler
      Then CurrentPrincipal is provided
      And CurrentPrincipal resolves to AnonymousPrincipal
      And the request is not failed with "Unauthenticated"

    @REQ-EA-074
    Scenario: A request with a valid credential under OptionalAuthentication resolves to the signed-in principal
      Given a group of endpoints under "OptionalAuthentication"
      And a signed-in user "alice" with a valid session cookie
      When "alice"'s request reaches the handler
      Then CurrentPrincipal resolves to "alice"'s UserPrincipal

    @REQ-EA-075
    Scenario: A single handler serves both signed-in and anonymous callers on one success path
      Given a group of endpoints under "OptionalAuthentication"
      When the handler reads CurrentPrincipal and branches on its tag
      Then both the signed-in branch and the AnonymousPrincipal branch are expressed as success outcomes
      And no parallel catchTag("Unauthenticated") path is needed

  # BEH-EA-030 — spec/behaviors/04-contract-stratum.md; see also
  # INV-EA-011.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (generated-client type-checking), not a runtime step. These
  # scenarios record the intended developer-facing outcome; the compiler-
  # checked half is proven in features/step-definitions/ContractTypeGates.ts
  # (compiled by the typecheck gate), the runtime half by the steps.
  @BEH-EA-030 @compile-time
  Rule: CsrfProtection declares requiredForClient: true, gating client generation at the type level

    @REQ-EA-076
    Scenario: A client build supplying the CsrfProtection client layer composes into a usable client
      Given an HttpApi group carrying "CsrfProtection"
      And a client build that supplies HttpApiMiddleware.layerClient(CsrfProtection, ...)
      When the client is composed
      Then the composition succeeds and produces a usable HttpApiClient / AtomHttpApi.Service

    @REQ-EA-077
    Scenario: A client build omitting the CsrfProtection client layer fails to compose
      Given an HttpApi group carrying "CsrfProtection"
      And a client build that omits the CsrfProtection client layer
      When the client is composed
      Then composition is rejected
      And the rejection names "ForClient<CsrfProtection>" as still required

  # BEH-EA-031 — spec/behaviors/04-contract-stratum.md
  @BEH-EA-031
  Rule: Core owns a session group at the API root, with current, list, signOut, revoke, revokeOthers, and revokeAll

    @REQ-EA-078
    Scenario: The core session group mounts at the root of the composed HttpApi
      Given an HttpApi composed from core alone, with no plugin installed
      When the composed HttpApi is inspected
      Then the "session" group is mounted at the root of "/auth"
      And it is not nested under any plugin's namespace prefix

    @REQ-EA-079
    Scenario Outline: The session group exposes its six endpoints
      Given the composed HttpApi's "session" group
      When the group's endpoints are inspected
      Then it exposes "<endpoint>" at "<method> <path>"

      Examples:
        | endpoint      | method | path                       |
        | current       | GET    | /auth/session              |
        | list          | GET    | /auth/session/list          |
        | signOut       | POST   | /auth/session/sign-out      |
        | revoke        | POST   | /auth/session/revoke        |
        | revokeOthers  | POST   | /auth/session/revoke-others |
        | revokeAll     | POST   | /auth/session/revoke-all    |

    @REQ-EA-080
    Scenario: The session group's endpoints are reachable with no plugin installed
      Given an application composed from core alone, with no plugin installed
      And a signed-in user "alice"
      When "alice" calls the "list", "revoke", "revokeOthers", and "signOut" endpoints through the generated client
      Then every call succeeds without any plugin being present

  # BEH-EA-032 — spec/behaviors/04-contract-stratum.md
  # Compile-time contract: the enforcing mechanism is, for Auth.make, the
  # TypeScript compiler (the same Validate<P> machinery as BEH-EA-009); for
  # contracts merged outside Auth.make, it is a composition-time evaluation
  # of HttpApi.addHttpApi, not a request-time HTTP response either way.
  # These scenarios record the intended developer-facing outcome; the
  # compiler-checked half is proven in features/step-definitions/
  # PluginTypeGates.ts, the runtime half (GroupIdConflict) by the steps.
  @BEH-EA-032 @compile-time
  Rule: Auth.api merges contracts and refuses a duplicate group id

    @REQ-EA-081
    Scenario: Two plugins contributing the same group id fail composition through Auth.make
      Given a plugin tuple containing "login" and a third-party "login.legacy", both contributing an HttpApiGroup id "login.legacy"
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names both "login" and "login.legacy" as the contributing plugins

    # @skip: raw HttpApi.addHttpApi replaces a same-id group silently (Effect's assignProperty, last wins) — awthaq only refuses a duplicate through Auth.make's composeApi (REQ-EA-081/083); blocked by PV-251
    @skip
    @REQ-EA-082
    Scenario: Merging raw contracts outside Auth.make rejects a duplicate group id at the point they are merged
      Given two raw HttpApiGroup contracts, both declaring the group id "password", composed outside Auth.make via HttpApi.addHttpApi
      When the contracts are merged
      Then the merge is rejected as "E_GROUP_CONFLICT"
      And neither group silently replaces the other

    @REQ-EA-083
    Scenario: A duplicate group id is never resolved by array order
      Given a plugin tuple containing "login" and "login.legacy" that both contribute the group id "login.legacy"
      When "Auth.make" composes the tuple regardless of which plugin appears later in the array
      Then composition is rejected
      And the outcome does not depend on which plugin was added to the array last

    @REQ-EA-640
    Scenario: The composed api is the one served document, carrying core's session and account groups
      Given a plugin tuple containing "password"
      When "Auth.make" composes the tuple
      Then the composed api's groups are "session", "account" and "password"
      And a plugin contributing a group id "session" is rejected as "E_GROUP_CONFLICT" naming "core"
