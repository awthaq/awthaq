# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@authorization-bridge @qadi-resolvers-obligations
@skip @unwired
Feature: Qadi Resolvers and Obligations

  # BEH-EA-161 — spec/behaviors/21-qadi-resolvers-obligations.md; see also
  # INV-EA-012.
  @BEH-EA-161
  Rule: Attributes resolved from the user table

    @REQ-EA-451
    Scenario: The resolver returns undefined for an attribute it has no opinion on
      Given awthaq's user-table-backed AttributeResolver
      When it is asked to resolve an attribute it does not recognize for a subject
      Then it returns undefined
      And undefined is understood to mean only "this resolver has no opinion on this attribute"

    @REQ-EA-452
    Scenario: A user-table lookup failure maps to a typed AttributeResolveError
      Given awthaq's user-table-backed AttributeResolver
      And the user table is unreachable while resolving the "plan" attribute for a subject
      When it is asked to resolve that attribute
      Then it fails with a typed AttributeResolveError naming the subject and the attribute
      And it does not return undefined
      And it does not swallow the failure as an uncaught exception

    @REQ-EA-453
    Scenario: A resolver failure is never indistinguishable from "this subject has no such attribute"
      Given awthaq's user-table-backed AttributeResolver
      And the user table is experiencing an outage
      When it is asked to resolve the "plan" attribute for a subject who does have a plan
      Then the outage surfaces as a typed AttributeResolveError
      And it is never reported the same way as a subject who genuinely has no "plan" attribute

  # BEH-EA-162 — spec/behaviors/21-qadi-resolvers-obligations.md
  @BEH-EA-162
  Rule: Relationships resolved from organization membership

    @REQ-EA-454
    Scenario: A "member" relation is resolved by walking from the resource to its owning organization and checking membership there
      Given awthaq's Organization.relationships resolver
      And a project that belongs to an organization a subject is a member of
      When it is asked whether the subject has a "member" relation to that project at depth 2
      Then it walks from the project to its owning organization
      And it checks the subject's membership in that organization

    @REQ-EA-455
    Scenario: A failure while walking the resource-to-organization relation maps to a typed RelationshipResolveError
      Given awthaq's Organization.relationships resolver
      And the organization-membership lookup fails while walking from a resource to its owning organization
      When it is asked to check a "member" relation for a subject against that resource
      Then it fails with a typed RelationshipResolveError naming the subject, relation, and resource
      And it does not report "Unrelated"

  # BEH-EA-163 — spec/behaviors/21-qadi-resolvers-obligations.md
  @BEH-EA-163
  Rule: Fixed graphs use relationshipResolverFromEdges

    @REQ-EA-456
    Scenario: A test or deployment with a small, statically known relationship graph uses relationshipResolverFromEdges as a drop-in resolver
      Given a fixed set of relationship edges, such as {subjectId: "user:u1", relation: "member", resourceId: "p1"}
      When relationshipResolverFromEdges is provided in place of Organization.relationships
      Then it implements the same RelationshipResolver interface
      And it answers relation checks against that fixed edge set

    @REQ-EA-457
    Scenario: A policy written against hasRelationship behaves identically regardless of which RelationshipResolver backs it
      Given a policy using hasRelationship
      When it is evaluated once with Organization.relationships providing RelationshipResolver and once with relationshipResolverFromEdges providing it
      Then the policy is written and evaluated the same way in both cases
      And it does not need to know or care which implementation is in effect

    @REQ-EA-458
    Scenario: Two plugins each contributing an AttributeResolver Layer for the same attribute are not flagged as a conflict by Auth.make
      Given a plugin "Organization" and a hypothetical plugin "Billing", each providing a Layer.effect(AttributeResolver, ...) for the "plan" attribute
      When "Auth.make" composes a tuple containing both plugins
      Then composition succeeds without naming "Organization", "Billing", or "plan" as a conflict
      And AttributeResolver is not one of awthaq's own declared slots that SlotConflict<P> inspects

    @REQ-EA-459
    Scenario: The later-provided resolver Layer silently shadows the earlier one for the same attribute
      Given a plugin "Organization" and a hypothetical plugin "Billing", each providing a Layer.effect(AttributeResolver, ...) for the "plan" attribute
      When both Layers are composed into one application, with "Billing"'s provided after "Organization"'s
      Then "Billing"'s AttributeResolver is the one reachable for the "plan" attribute
      And "Organization"'s contribution for "plan" becomes unreachable with no compiler error naming either plugin

  # BEH-EA-164 — spec/behaviors/21-qadi-resolvers-obligations.md
  @BEH-EA-164
  Rule: Decision history backed by audit events

    @REQ-EA-460
    Scenario: hasActed answers from durable audit event records, not in-memory state
      Given awthaq's audit-table-backed DecisionHistory
      And a subject whose "accepted-terms" event was recorded before the current process started
      When it is asked hasActed for that subject and event
      Then it answers "Acted"
      And the answer is read from the durable audit table, not from any in-memory cache of this process

    @REQ-EA-461
    Scenario: An audit-table query failure while answering hasActed maps to a typed DecisionHistoryUnavailable
      Given awthaq's audit-table-backed DecisionHistory
      And the audit table is unreachable while answering hasActed for a subject and event
      When it is asked hasActed for that subject and event
      Then it fails with a typed DecisionHistoryUnavailable
      And it does not answer "NotActed"

    @REQ-EA-462
    Scenario: A database outage does not silently deny a subject who has genuinely acted
      Given awthaq's audit-table-backed DecisionHistory
      And a subject who genuinely has a durable "accepted-terms" event recorded
      And the audit table becomes unreachable
      When it is asked hasActed for that subject and event during the outage
      Then it fails with a typed DecisionHistoryUnavailable rather than reporting "NotActed"

  # BEH-EA-165 — spec/behaviors/21-qadi-resolvers-obligations.md. qadi's own
  # policy evaluation is a black box throughout this file: "qadi's evaluator
  # would return an Allow decision carrying an obligation" is a Given, never
  # something derived from role or permission logic here — that logic is
  # qadi's own specification's job. These scenarios cover only awthaq's
  # own ObligationHandlers.reauth discharge implementation.
  @BEH-EA-165
  Rule: The reauth obligation discharges from session freshness

    @REQ-EA-463
    Scenario: A session authenticated within the obligation's maxAgeSeconds discharges the reauth obligation
      Given the "reauth" obligation configured with maxAgeSeconds 300
      And a signed-in user "alice" whose session's authenticatedAt is 60 seconds ago
      And qadi's evaluator would return an Allow decision carrying the "reauth" obligation for "alice"'s request
      When "alice" calls an endpoint enforced with ObligationHandlers.reauth
      Then the reauth obligation discharges
      And the request proceeds

    @REQ-EA-464
    Scenario: A session authenticated longer ago than maxAgeSeconds fails discharge with a typed re-authentication error
      Given the "reauth" obligation configured with maxAgeSeconds 300
      And a signed-in user "alice" whose session's authenticatedAt is 600 seconds ago
      And qadi's evaluator would return an Allow decision carrying the "reauth" obligation for "alice"'s request
      When "alice" calls an endpoint enforced with ObligationHandlers.reauth
      Then discharge fails with a typed re-authentication error
      And the request does not proceed

    @REQ-EA-465
    Scenario: A session that is otherwise currently valid is not accepted merely because it has not expired
      Given the "reauth" obligation configured with maxAgeSeconds 300
      And a signed-in user "alice" whose session is otherwise unexpired but whose authenticatedAt is 600 seconds ago
      And qadi's evaluator would return an Allow decision carrying the "reauth" obligation for "alice"'s request
      When "alice" calls an endpoint enforced with ObligationHandlers.reauth
      Then discharge fails with a typed re-authentication error
      And the session's own current validity does not substitute for authenticatedAt freshness

  # BEH-EA-166 — spec/behaviors/21-qadi-resolvers-obligations.md
  @BEH-EA-166
  Rule: SQL pushdown, and its limit

    @REQ-EA-466
    Scenario: A policy containing a hasRelationship node fails compileSql with PredicateNotRenderable
      Given a policy that contains a hasRelationship node
      When it is compiled to SQL via toPredicate and compileSql
      Then compilation fails with PredicateNotRenderable

    @REQ-EA-467
    Scenario: compileSql never silently omits or approximates the hasRelationship portion of a policy
      Given a policy that contains a hasRelationship node
      When it is compiled to SQL via toPredicate and compileSql
      Then no partial WHERE clause that silently drops the hasRelationship condition is ever returned
      And the caller never receives rows that were only excluded by the omitted condition

    @REQ-EA-468
    Scenario: The caller splits a policy containing a hasRelationship node into a SQL-rendered part and a filter-evaluated part
      Given a policy containing both SQL-renderable conditions and a hasRelationship node
      When compileSql fails with PredicateNotRenderable for the whole policy
      Then the caller renders the SQL-renderable part to a WHERE clause
      And evaluates the hasRelationship part separately with filter

  # BEH-EA-167 — spec/behaviors/21-qadi-resolvers-obligations.md
  @BEH-EA-167
  Rule: A sink cannot change a decision

    @REQ-EA-469
    Scenario: A broken or unreachable audit DecisionSink trips its own breaker and logs
      Given an AuditDecisionSinkLive configured with a failureThreshold of 5
      And the audit sink's underlying storage becomes unreachable
      When 5 consecutive decisions fail to reach the audit sink
      Then the sink's own breaker trips
      And the failure is logged

    @REQ-EA-470
    Scenario: A broken audit DecisionSink does not block or delay the response to the request that produced the decision
      Given an audit DecisionSink whose underlying storage is unreachable
      When a request produces a decision that is routed to that sink
      Then the request's response is returned without waiting on the sink
      And the response is not delayed by the sink's failure

    @REQ-EA-471
    Scenario: A broken audit DecisionSink does not alter the decision's answer
      Given an audit DecisionSink whose underlying storage is unreachable
      And qadi's evaluator would return an Allow decision for a request
      When that request's decision is routed to the broken sink
      Then the request still receives the Allow decision's outcome unchanged
      And only the audit trail, not the decision, is marked as degraded

  # BEH-EA-168 — spec/behaviors/21-qadi-resolvers-obligations.md
  @BEH-EA-168
  Rule: The guarded devtools decision stream

    @REQ-EA-472
    Scenario: The decision stream route is guarded by a policy
      Given decisionStreamRoute is registered behind a policy
      And qadi's evaluator would return a Deny decision for that policy for a caller with no admin access
      When that caller requests the decision stream
      Then the stream is not opened for them

    @REQ-EA-473
    Scenario: The stream re-checks the viewing subject at the configured interval
      Given decisionStreamRoute is configured with reauth every 30 seconds
      And a signed-in admin "alice" is viewing the stream
      When 30 seconds elapse
      Then "alice"'s access is re-checked against the stream's guarding policy

    @REQ-EA-474
    Scenario: A viewer whose access is revoked mid-stream stops receiving further decisions once the next re-check runs
      Given decisionStreamRoute is configured with reauth every 30 seconds
      And a signed-in admin "alice" is viewing the stream
      When "alice"'s admin access is revoked and the next 30-second re-check runs
      Then qadi's evaluator returns a Deny decision for "alice" against the stream's guarding policy
      And "alice" stops receiving further decisions from the stream

    @REQ-EA-475
    Scenario: A viewer whose access is revoked mid-stream may still receive decisions until the next scheduled re-check
      Given decisionStreamRoute is configured with reauth every 30 seconds
      And a signed-in admin "alice" is viewing the stream
      When "alice"'s admin access is revoked 5 seconds after the most recent re-check
      Then "alice" may still receive decisions from the stream for up to the remaining 25 seconds
      And the cutoff is bounded by the re-check interval, not immediate upon revocation
