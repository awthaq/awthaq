# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

@cross-cutting @events
Feature: Events

  # BEH-EA-097 — spec/behaviors/13-events.md; see also ADR-EA-001.
  @BEH-EA-097
  Rule: AuthEvents is a bounded PubSub

    @REQ-EA-259
    Scenario: AuthEvents is backed by a bounded PubSub, not an unbounded one
      Given the "AuthEvents" service
      When its underlying "PubSub" is inspected
      Then it has a finite configured capacity
      And it is not "PubSub.unbounded"

    @REQ-EA-260
    Scenario: A slow or absent subscriber cannot grow the publishing process's memory without bound
      Given a subscriber to "AuthEvents" that never catches up with published events
      When events continue to be published while that subscriber lags
      Then the backlog held for that subscriber is bounded by the PubSub's fixed capacity
      And the publishing process's memory does not grow without bound

  # BEH-EA-098 — spec/behaviors/13-events.md
  @BEH-EA-098
  Rule: A publisher never awaits its subscribers

    @REQ-EA-261
    Scenario: Publishing an event returns without waiting for any subscriber to finish handling it
      Given a subscriber to "AuthEvents" that takes a long time to handle each event
      When an event is published while that subscriber is still processing a previous event
      Then "publish" returns as soon as the event is recorded and offered to the bounded bus, whether or not the bus accepted it
      And the publishing fiber is not suspended waiting on the subscriber or on the bus's capacity

    @REQ-EA-262
    Scenario: A sign-in is not slowed down by a slow subscriber observing it
      Given a signed-in user "alice" whose sign-in publishes "auth.user.signedIn" to a slow analytics subscriber
      When "alice" signs in
      Then the sign-in operation completes without waiting on the analytics subscriber
      And its latency is unaffected by how long that subscriber takes to run

  # BEH-EA-099 — spec/behaviors/13-events.md
  @BEH-EA-099
  Rule: Subscribers run on forked, isolated fibers — a failing subscriber cannot affect the publisher or any other subscriber

    @REQ-EA-263
    Scenario: Each subscription to AuthEvents runs on its own forked fiber
      Given two independent subscriptions to "AuthEvents", "Analytics" and "SecurityAlerts"
      When an event is published
      Then "Analytics" and "SecurityAlerts" each handle the event on their own forked fiber

    @REQ-EA-264
    Scenario: A failing subscriber's failure is caught and logged rather than propagated to the publisher
      Given a signed-in user "alice" whose sign-in publishes "auth.user.signedIn"
      And a subscriber "Analytics" that fails while handling that event
      When "alice" signs in
      Then "Analytics"'s failure is caught and logged
      And the sign-in operation that published the event is unaffected

    @REQ-EA-265
    Scenario: A failing subscriber cannot affect another subscriber observing the same event
      Given two subscribers, "Analytics" and "SecurityAlerts", both handling "auth.user.signedIn"
      When "Analytics" fails while handling an event
      Then "SecurityAlerts" still receives and handles that same event
      And "SecurityAlerts"'s handling is unaffected by "Analytics"'s failure

  # BEH-EA-100 — spec/behaviors/13-events.md
  @BEH-EA-100
  Rule: The audit table is the durable record of record, independent of the PubSub stream

    @REQ-EA-266
    Scenario: A security-relevant operation's audit record is written durably as part of the operation itself
      Given a signed-in user "alice" who signs in, a security-relevant, audited operation
      When "alice" signs in
      Then an audit record for the sign-in is written durably to persistence as part of that same operation

    @REQ-EA-267
    Scenario: The audit record does not depend on any AuthEvents subscriber being present, running, or succeeding
      Given no subscriber is registered on "AuthEvents", or the only registered subscriber fails
      When a security-relevant operation is performed
      Then the audit record for that operation is still written durably
      And the absence or failure of an event subscriber causes no audit gap

  # BEH-EA-101 — spec/behaviors/13-events.md
  @BEH-EA-101
  Rule: Events are typed, tagged values forming a registry contract

    @REQ-EA-268
    Scenario: Every published event is a tagged value from the closed, statically-known event registry
      Given the event registry declares "auth.user.created", "auth.user.signedIn", "auth.token.replay", and "auth.session.issued"
      When an event is published to "AuthEvents"
      Then the event's tag is one of the registry's declared tags

    @REQ-EA-269
    Scenario: A subscriber filtering or handling by tag can rely on that tag's declared payload shape
      Given a subscriber handling events tagged "auth.user.signedIn"
      When it destructures the event payload's "userId" and "strategy" fields
      Then those fields are present, shaped exactly as the registry declares for that tag

    @REQ-EA-270
    Scenario: A new event tag added to the registry does not break an existing subscriber filtering on tags it already knows about
      Given an existing subscriber filtering only on "auth.user.created"
      When a new event tag is added to the registry
      Then the existing subscriber continues to receive and handle "auth.user.created" events unaffected

  # BEH-EA-102 — spec/behaviors/13-events.md
  @BEH-EA-102
  Rule: The raw event stream is available for direct, low-level consumption

    @REQ-EA-271
    Scenario: AuthEvents exposes its underlying stream directly, alongside the on(tag, handler) sugar
      Given the "AuthEvents" service
      When a consumer accesses "ev.stream" directly instead of using "AuthEvents.on"
      Then the raw event stream is available for that consumer to pipe through its own operators

    @REQ-EA-272
    Scenario: A consumer filtering across several event tags at once is not limited to the one-tag-one-handler shape
      Given a consumer that wants to alert on "auth.token.replay" using a custom predicate over the raw stream
      When it filters "ev.stream" with that predicate and runs it on a forked, scoped fiber
      Then it can do so without being restricted to registering one handler per single tag via "AuthEvents.on"

  # BEH-EA-103 — spec/behaviors/13-events.md
  @BEH-EA-103
  Rule: AuthEvents.on(tag, handler) is sugar that produces a subscription Layer

    @REQ-EA-273
    Scenario: AuthEvents.on(tag, handler) returns a Layer that, once provided, establishes an isolated subscription
      Given a plugin author writes "AuthEvents.on(\"auth.user.created\", handler)"
      When the resulting "Layer" is provided into the application
      Then a subscription satisfying the same fork-per-subscriber isolation as BEH-EA-099 is established

    @REQ-EA-274
    Scenario: A plugin author does not need to write Stream.runForEach or Effect.forkScoped themselves to get a correctly isolated subscriber
      Given a plugin author using "AuthEvents.on(tag, handler)"
      When they compose their subscription
      Then they do not write "Stream.runForEach" or "Effect.forkScoped" themselves
      And the isolation guarantee still holds

  # BEH-EA-104 — spec/behaviors/13-events.md; see also INV-EA-010.
  @BEH-EA-104
  Rule: A failing subscriber is logged under a stable, queryable event name and never re-raised

    @REQ-EA-275
    Scenario: A subscriber failure is logged under the stable event name auth.event.observer.error
      Given a subscriber that fails while handling an event
      When the failure is logged
      Then it is logged under the event name "auth.event.observer.error"
      And the log entry identifies which subscription and which event triggered it

    @REQ-EA-276
    Scenario: A subscriber failure is never re-raised to any caller
      Given a signed-in user "alice" whose sign-in publishes an event a subscriber fails to handle
      When that subscriber's failure occurs
      Then the failure is not re-raised to "alice"'s sign-in call or its caller
      And it is terminal at the point it is logged

    @REQ-EA-277
    Scenario: A subscriber-failure log is distinguishable from a security-event log like auth.token.replay
      Given both a subscriber failure and a genuine "auth.token.replay" security event have occurred
      When an operator queries logs for "auth.event.observer.error"
      Then only subscriber-failure entries are returned
      And genuine "auth.token.replay" security events are not conflated with subscriber failures
