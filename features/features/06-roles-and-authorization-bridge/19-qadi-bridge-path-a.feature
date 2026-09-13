# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@authorization-bridge @qadi-bridge-path-a
Feature: Qadi Bridge — Path A (Decide in Handler)

  # BEH-EA-145 — spec/behaviors/19-qadi-bridge-path-a.md; see also
  # ADR-EA-009.
  @BEH-EA-145
  Rule: `AuthorizedSubject` bridges `CurrentPrincipal` to `CurrentSubject`

    @REQ-EA-405
    Scenario: AuthorizedSubject provides qadi's CurrentSubject by resolving the principal Authentication already provided
      Given an endpoint group with middleware ".middleware(Authentication).middleware(AuthorizedSubject)"
      When a signed-in user's request passes through the group's middleware chain
      Then "AuthorizedSubject" reads "CurrentPrincipal" already provided by "Authentication"
      And "AuthorizedSubject" provides qadi's "CurrentSubject" to every handler in the group via "SubjectResolver"

    @REQ-EA-406
    Scenario: A group declaring AuthorizedSubject without Authentication preceding it fails composition, not at first request
      Given an endpoint group that declares ".middleware(AuthorizedSubject)" without ".middleware(Authentication)" preceding it in the chain
      When the group is composed
      Then composition is rejected, because "AuthorizedSubject" has no "CurrentPrincipal" in its required environment
      And the ordering violation is caught before any request reaches the group

    @REQ-EA-407
    Scenario: Handlers in the group read CurrentSubject as a provided value and perform no resolution of their own
      Given an endpoint group under ".middleware(Authentication).middleware(AuthorizedSubject)"
      When a handler in the group runs
      Then the handler reads "CurrentSubject" as an already-provided environment value
      And the handler performs no "SubjectResolver" call of its own

  # BEH-EA-146 — spec/behaviors/19-qadi-bridge-path-a.md; see also
  # ADR-EA-015.
  @BEH-EA-146
  Rule: One call per need, not one call for everything

    @REQ-EA-408
    Scenario Outline: A handler selects the qadi call whose shape matches its need
      Given a handler with the need "<need>"
      When the handler is implemented
      Then it uses "<call>"

      Examples:
        | need                                           | call                                                     |
        | yes/no, no obligations                         | check(policy, { resource })                               |
        | the full decision: trace, fields, obligations  | decide(policy, { resource })                              |
        | precondition before imperative code             | assert(policy)                                            |
        | gate one effect                                 | enforce(policy)(effect)                                   |
        | gate and trim the result to granted fields      | enforceProjected(policy)(effect)                          |
        | authorize a collection item by item             | filter(policy, items) / filterStream                      |
        | downstream code needs proof                     | guard(permission, policy)(resource, (witness, r) => …)    |

    @REQ-EA-409
    Scenario: A handler must not layer check plus hand-written field-trimming where enforceProjected already does both
      Given a handler that needs to gate an effect and trim its result to the fields a policy decision granted
      When the handler is implemented
      Then it uses "enforceProjected" alone
      And it does not call "check" and then hand-write field-trimming logic to achieve the same result

  # BEH-EA-147 — spec/behaviors/19-qadi-bridge-path-a.md. qadi's own policy
  # evaluation is a black box throughout this file: "qadi's evaluator would
  # return an Allow/Deny decision" is a Given, never something derived from
  # role or permission logic here — that logic is qadi's own specification's
  # job.
  @BEH-EA-147
  Rule: Cross-tenant denial becomes 404, not 403

    @REQ-EA-410
    Scenario: A request for another tenant's resource by valid id is reported as not found
      Given a resource "project-42" that exists in a tenant the caller cannot access
      And qadi's evaluator would return a Deny decision for the caller against "project-42"
      When the caller requests "project-42" by id
      Then the response is "404 Not Found"
      And the response does not distinguish "denied" from "does not exist"

    @REQ-EA-411
    Scenario: A request for a resource id that does not exist at all produces the same response as a cross-tenant denial
      Given a resource id "project-999" that does not exist anywhere
      When the caller requests "project-999" by id
      Then the response is "404 Not Found"
      And the response is indistinguishable from the response for a resource that exists in a tenant the caller cannot access

    @REQ-EA-412
    Scenario: A handler must not let a 403 respond to a request for a resource id the caller has no access to
      Given qadi's evaluator would return a Deny decision for the caller against a tenant-scoped resource requested by id
      When the handler processes the request
      Then "AccessDenied" is mapped to the resource's own not-found error
      And the response is never "403 Forbidden"

  # BEH-EA-148 — spec/behaviors/19-qadi-bridge-path-a.md
  @BEH-EA-148
  Rule: Resolver outages stay 5xx

    @REQ-EA-413
    Scenario: An attribute-resolver outage surfaces as a defect, not a denial
      Given qadi's AttributeResolver fails while evaluating a policy for the caller
      When the caller requests a resource gated by that policy
      Then the response is a 5xx server error
      And the response is never mapped to "403 Forbidden" or "404 Not Found"

    @REQ-EA-414
    Scenario: A resolver outage and a policy denial are never collapsed into the same handler branch
      Given a handler that separately catches "AccessDenied" into 404 and resolver-outage errors into a defect
      When a resolver-outage error occurs
      Then it is not caught by the "AccessDenied" branch
      And it propagates as a defect

    @REQ-EA-415
    Scenario Outline: Each kind of resolver-outage error surfaces as a defect, never a denial
      Given qadi's "<resolver-error>" occurs while evaluating a policy for the caller
      When the caller requests a resource gated by that policy
      Then the response is a 5xx server error

      Examples:
        | resolver-error              |
        | AttributeResolveError       |
        | RelationshipResolveError    |
        | DecisionHistoryUnavailable  |

  # BEH-EA-149 — spec/behaviors/19-qadi-bridge-path-a.md
  @BEH-EA-149
  Rule: `enforceProjected` trims the response to granted fields

    @REQ-EA-416
    Scenario: enforceProjected trims the wrapped effect's success value to the fields the decision granted
      Given qadi's evaluator would grant access to a subset of "project-42"'s fields for the caller
      When the caller requests "project-42" through a handler using "enforceProjected"
      Then the returned value is trimmed to exactly the fields the decision granted

    @REQ-EA-417
    Scenario: A handler using enforceProjected must not additionally hand-write field redaction on the same path
      Given a handler using "enforceProjected" to read "project-42"
      When the handler is implemented
      Then it performs no additional hand-written field redaction on the same path
      And the trimming logic lives only inside "enforceProjected"

    @REQ-EA-418
    Scenario: enforceProjected composes with a handler's AccessDenied and resolver-outage handling without altering either
      Given a handler pipeline using "enforceProjected", then the "AccessDenied"-to-not-found mapping, then the resolver-outage-to-defect mapping
      And qadi's evaluator would return a Deny decision for the caller against "project-42"
      When the caller requests "project-42"
      Then the response is "404 Not Found"
      And "enforceProjected"'s field-trimming plays no role in that denial path

  # BEH-EA-150 — spec/behaviors/19-qadi-bridge-path-a.md
  @BEH-EA-150
  Rule: `filter` decides a collection item by item

    @REQ-EA-419
    Scenario: filter includes only the items an Allow decision was returned for
      Given a caller requesting a list of resources, where qadi's evaluator would return a Deny decision for some items and an Allow decision for others
      When the handler serves the list using "filter"
      Then only the items with an Allow decision are included in the response
      And items with a Deny decision are dropped before the response is produced

    @REQ-EA-420
    Scenario: filterStream decides each item of a streamed list individually
      Given a caller requesting a streamed list of resources
      When the handler serves the stream using "filterStream"
      Then each item is decided individually against the policy as it streams
      And denied items are dropped from the stream before it reaches the caller

    @REQ-EA-421
    Scenario: A handler must not return the full loaded collection and rely on the client to hide denied items
      Given a handler returning a list of resources
      When the handler is implemented
      Then it does not return the full loaded collection and rely on the client to hide items it should not see
      And denied items never cross the wire in the response body

  # BEH-EA-151 — spec/behaviors/19-qadi-bridge-path-a.md
  @BEH-EA-151
  Rule: `guard` hands the handler an unforgeable witness

    @REQ-EA-422
    Scenario: guard hands downstream code an unforgeable witness proving the permission was granted for the specific resource
      Given a handler deleting "project-42" where downstream code requires proof of "project.delete" for that specific resource
      When the handler uses "guard(project.delete, canDeleteProject)(resource, (witness, r) => …)"
      Then the downstream removal function receives an unforgeable witness proving the permission was granted for that resource
      And the removal cannot be invoked without that witness having been produced by "guard"

    @REQ-EA-423
    Scenario: A handler must not thread a boolean in place of the witness
      Given a handler needing downstream proof that "project.delete" was granted for "project-42"
      When the handler is implemented
      Then it does not thread a boolean flag as a substitute for the witness
      And the downstream removal function's signature requires the actual witness value, not a boolean

    @REQ-EA-424
    Scenario: A handler must not re-derive the same conclusion by calling check a second time
      Given a handler that already obtained a witness via "guard" for "project-42"
      When the handler proceeds to the downstream removal step
      Then it does not call "check" a second time to re-derive the same conclusion
      And the witness already obtained is the sole proof used

  # BEH-EA-152 — spec/behaviors/19-qadi-bridge-path-a.md
  @BEH-EA-152
  Rule: Bare `HttpRouter` routes use `addGuardedRoute`

    @REQ-EA-425
    Scenario: A bare HttpRouter route needing authorization is registered with addGuardedRoute
      Given a bare "HttpRouter" route "GET /projects/:id/export.csv" outside "HttpApi" that needs authorization
      When the route is registered using "addGuardedRoute" with "project.read" and a policy
      Then the route requires "SubjectExtractor" to supply the subject
      And a successful decision mints the same kind of witness "guard" produces for handlers inside "HttpApi"

    @REQ-EA-426
    Scenario: A bare HttpRouter route must not hand-check CurrentPrincipal and skip qadi's evaluator
      Given a bare "HttpRouter" route outside "HttpApi" that needs authorization
      When the route is implemented
      Then it does not hand-check "CurrentPrincipal" itself
      And it does not skip qadi's evaluator for being outside the typed contract

    @REQ-EA-427
    Scenario: A contract-shaped route and a bare-router route reach the evaluator through different plumbing, never a second ad hoc check
      Given a contract-shaped endpoint using "AuthorizedSubject" and a bare "HttpRouter" route using "addGuardedRoute" in the same application
      When each is authorized
      Then the contract-shaped endpoint is resolved via "AuthorizedSubject"'s "CurrentSubject" and the bare route via "SubjectExtractor"
      And neither route reaches qadi's evaluator through a second, ad hoc check
