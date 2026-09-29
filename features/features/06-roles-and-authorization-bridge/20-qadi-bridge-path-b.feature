# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@authorization-bridge @qadi-bridge-path-b
@skip @unwired
Feature: Qadi Bridge — Path B (Declared Permissions)

  # BEH-EA-153 — spec/behaviors/20-qadi-bridge-path-b.md; see also
  # ADR-EA-009.
  @BEH-EA-153
  Rule: SubjectExtractor runs session resolution on the raw request

    @REQ-EA-428
    Scenario: SubjectExtractor resolves a subject directly from the raw request, ahead of any awthaq contract middleware
      Given an endpoint middlewared only by qadi's RequirePermission, with SubjectExtractor provided over the raw request
      When a request reaches that endpoint
      Then SubjectExtractor resolves a subject before any awthaq contract middleware has executed
      And it does so without depending on Authentication's own middleware pipeline having run first

    @REQ-EA-429
    Scenario: SubjectExtractor reuses Authentication's own session-verification logic rather than a second implementation
      Given a request carrying a session credential
      When SubjectExtractor and Authentication's middleware each resolve a session from that credential
      Then both apply the identical hash-comparison and absolute/idle-expiry logic over Sessions
      And SubjectExtractor's resolution and Authentication's resolution agree on whether the session is valid

    @REQ-EA-430
    Scenario: SubjectExtractor must not hand-write its own independent hash-comparison or expiry check
      Given a SubjectExtractor implementation
      When its session-validity logic is inspected
      Then it contains no hash-comparison or expiry check distinct from the one Authentication's middleware uses
      And there is only one place a session-validity bug could be fixed, not two

  # BEH-EA-154 — spec/behaviors/20-qadi-bridge-path-b.md. qadi's own policy
  # evaluation is a black box throughout this file: "qadi's evaluator would
  # return an Allow/Deny decision" is a Given, never something derived from
  # role or permission logic here — that logic is qadi's own specification's
  # job.
  @BEH-EA-154
  Rule: RequirePermission reads the RequiredPermission annotation

    @REQ-EA-431
    Scenario: An endpoint's declared permission and policy are read from its RequiredPermission annotation
      Given an endpoint annotated with RequiredPermission via requiresPermission, declaring a permission and a policy
      And qadi's evaluator would return an Allow decision for that declared policy
      When a request reaches that endpoint
      Then RequirePermission evaluates exactly the policy declared in the annotation
      And the request is allowed to proceed

    @REQ-EA-432
    Scenario: The permission an endpoint requires is visible by reading the contract, without executing the handler
      Given an endpoint annotated with RequiredPermission
      When the contract is inspected without invoking the endpoint's handler
      Then the declared permission and policy are visible directly from the annotation

    @REQ-EA-433
    Scenario: RequirePermission never evaluates a policy other than the one declared in the annotation
      Given an endpoint annotated with RequiredPermission declaring one specific policy
      When a request reaches that endpoint
      Then only the declared policy is evaluated
      And no other, undeclared policy is additionally consulted

  # BEH-EA-155 — spec/behaviors/20-qadi-bridge-path-b.md
  @BEH-EA-155
  Rule: PublicEndpoint is the only other legal annotation

    @REQ-EA-434
    Scenario: An endpoint with no subject to evaluate against is declared PublicEndpoint with a documented reason
      Given an endpoint in a RequirePermission-middlewared group with no subject to evaluate, such as a liveness probe
      And it is annotated PublicEndpoint with the reason "liveness probe, no subject exists yet"
      When a request reaches that endpoint
      Then it is treated as legitimately public
      And no permission is evaluated for it

    @REQ-EA-435
    Scenario: Declaring PublicEndpoint without a documented reason string is not a legal declaration
      Given an endpoint in a RequirePermission-middlewared group
      When it is annotated PublicEndpoint with a bare boolean instead of a documented reason string
      Then the declaration is not legal
      And the endpoint carries no valid public-endpoint exemption

  # BEH-EA-156 — spec/behaviors/20-qadi-bridge-path-b.md; see also
  # INV-EA-013.
  @BEH-EA-156
  Rule: Absence of either annotation is refusal, not an open door

    @REQ-EA-436
    Scenario: An endpoint declaring neither annotation fails every request with a 500 and logs the endpoint's name
      Given an endpoint in a RequirePermission-middlewared group carrying neither RequiredPermission nor PublicEndpoint
      When any request reaches that endpoint
      Then the response is "500 Internal Server Error"
      And the log names the endpoint that was reached unannotated

    @REQ-EA-437
    Scenario: An unannotated endpoint is never reachable as an unguarded 200, even for a caller with a fully valid session
      Given an endpoint carrying neither RequiredPermission nor PublicEndpoint
      And a signed-in user "alice" with a fully valid, unexpired session
      When "alice" requests that endpoint
      Then the response is never "200 OK"
      And the response is "500 Internal Server Error"

    @REQ-EA-438
    Scenario: The unannotated-endpoint refusal reflects a wiring mistake, not a policy decision qadi ever evaluated
      Given an endpoint carrying neither RequiredPermission nor PublicEndpoint
      When a request reaches that endpoint
      Then the 500 response is produced without qadi's evaluator ever being asked to decide anything
      And the response is never "403 Forbidden"

    @REQ-EA-439
    Scenario: The unannotated-endpoint refusal is applied to every request to that endpoint, not only the first
      Given an endpoint carrying neither RequiredPermission nor PublicEndpoint
      When 10 separate requests reach that endpoint over time
      Then every one of the 10 responses is "500 Internal Server Error"
      And none of them is ever "200 OK"

  # BEH-EA-157 — spec/behaviors/20-qadi-bridge-path-b.md
  @BEH-EA-157
  Rule: Status mapping is qadi's, not awthaq's

    @REQ-EA-440
    Scenario Outline: RequirePermission maps each outcome to its designated status, with an empty body
      Given a request to an endpoint middlewared by RequirePermission that results in "<outcome>"
      When the response is served
      Then the response is "<status>"
      And the response body is empty

      Examples:
        | outcome                     | status                     |
        | an AccessDenied decision     | 403 Forbidden               |
        | an UndischargedObligation    | 403 Forbidden               |
        | a resolver outage            | 502 Bad Gateway              |
        | a missing annotation         | 500 Internal Server Error   |

    @REQ-EA-441
    Scenario: awthaq's bridge code does not reinterpret or override qadi's status mapping
      Given qadi's RequirePermission middleware maps an outcome to one of its designated statuses
      When awthaq's own bridge code serves that response
      Then the status served matches qadi's mapping exactly
      And no additional mapping layer inside awthaq changes it

    @REQ-EA-442
    Scenario: A resolver outage is never collapsed into a 403 denial
      Given qadi's AttributeResolver fails while evaluating a policy for an endpoint middlewared by RequirePermission
      When a request reaches that endpoint
      Then the response is "502 Bad Gateway"
      And the response is never "403 Forbidden"

  # BEH-EA-158 — spec/behaviors/20-qadi-bridge-path-b.md
  @BEH-EA-158
  Rule: The permission registry route

    @REQ-EA-443
    Scenario: The permission registry is derived purely from RequiredPermission annotations, without executing any handler
      Given a contract whose endpoints carry various RequiredPermission annotations
      When registerApi derives the permission registry from that contract
      Then the registry lists each declared permission and its endpoints
      And no handler for any of those endpoints is executed to produce it

    @REQ-EA-444
    Scenario: The permission registry route is itself guarded by a policy
      Given permissionRegistryRoute is registered behind a policy
      And qadi's evaluator would return an Allow decision for that policy for a signed-in user "alice"
      When "alice" requests "GET /__permissions"
      Then "alice" receives the permission registry

    @REQ-EA-445
    Scenario: The permission registry route is never served unauthenticated
      Given permissionRegistryRoute is registered behind a policy
      And qadi's evaluator would return a Deny decision for that policy for a caller with no valid session
      When that caller requests "GET /__permissions"
      Then the registry is not served to them

  # BEH-EA-159 — spec/behaviors/20-qadi-bridge-path-b.md; see also
  # ADR-EA-015.
  @BEH-EA-159
  Rule: Choosing Path B over Path A

    @REQ-EA-446
    Scenario: An endpoint that gates on subject state alone, with no loaded resource, is wired through Path B
      Given an endpoint whose policy needs only the caller's own subject state, such as hasRole("admin")
      When the endpoint is wired for authorization
      Then it is wired through Path B's RequiredPermission annotation, with no resource loaded beforehand

    @REQ-EA-447
    Scenario: An endpoint whose decision depends on a loaded resource's attributes cannot be wired through Path B alone
      Given an endpoint whose policy needs an attribute of a resource only available once a handler has loaded it, such as a project's ownerId
      When the endpoint is wired for authorization
      Then Path B's annotation-only evaluation has no loaded resource to hand the policy
      And the endpoint must instead be wired through Path A's guard or enforce inside the handler

  # BEH-EA-160 — spec/behaviors/20-qadi-bridge-path-b.md
  @BEH-EA-160
  Rule: Both bridges share one wiring root

    @REQ-EA-448
    Scenario: An application using both paths composes one merged AuthzLive Layer over one shared auth.layer
      Given an application using both Path A and Path B
      When its authorization wiring is composed
      Then AuthorizedSubjectLive and the RequirePermissionLive/SubjectExtractorLive pair are merged into one AuthzLive Layer
      And that merged Layer is built over the same auth.layer

    @REQ-EA-449
    Scenario: Path A and Path B are not wired from two independently-configured SubjectResolver instances
      Given an application using both Path A and Path B
      When its authorization wiring is inspected
      Then both paths are built over the identical SubjectResolver instance provided by auth.layer
      And no second, independently-configured SubjectResolver instance backs either path

    @REQ-EA-450
    Scenario: A caller resolves to the identical underlying subject whether the endpoint it hit was gated by Path A or by Path B
      Given a signed-in user "alice" and an application wired with one shared AuthzLive
      When "alice" makes one request to a Path-A-gated endpoint and another request to a Path-B-gated endpoint
      Then both requests resolve "alice" to the identical underlying AuthSubject
