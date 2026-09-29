@client-integration @react
Feature: React Bindings

  # BEH-EA-177 — spec/behaviors/23-react.md
  @BEH-EA-177
  Rule: RegistryProvider seeds the session atom for SSR

    @REQ-EA-501
    Scenario: RegistryProvider seeded with the server-resolved session shows it on first client render
      Given a server-resolved session for "alice"
      When "RegistryProvider" is rendered with "initialValues: [[sessionAtom, AsyncResult.success(initialSession)]]"
      Then the first client render shows "alice"'s resolved session

    @REQ-EA-502
    Scenario: The first client render shows no loading state for a session the server already knew
      Given "RegistryProvider" seeded with the server-resolved session for "alice"
      When the page performs its first client render
      Then no "checking session" loading state is shown
      And no client-side fetch is required before the session appears

    @REQ-EA-503
    Scenario: A server render with no session seeds a resolved absence, not a loading state
      Given the server resolved no session for the current request
      When "RegistryProvider" is seeded with "AsyncResult.success(null)" as the session atom's initial value
      Then the first client render reflects a resolved signed-out state, not a pending session lookup

  # BEH-EA-178 — spec/behaviors/23-react.md
  @BEH-EA-178
  Rule: Mutations invalidate the session reactivity key

    @REQ-EA-504
    Scenario Outline: A mutation that changes the current session tags reactivityKeys with session
      Given a signed-in user "alice"
      When "<mutation>" is performed
      Then the mutation runs with "reactivityKeys: [\"session\"]"
      And "sessionAtom" refetches automatically, without application code calling a manual refetch

      Examples:
        | mutation          |
        | sign-in           |
        | sign-out          |

    # @skip: plugin-owned mutations (role assignment, accepting an invite) need an organization/roles
    # composition and their own makeReactClient atoms, and no such atoms ship in @awthaq/react; the
    # mechanism is the same reactivityKeys wiring REQ-EA-504's wired rows prove.
    @skip
    Scenario Outline: A plugin mutation that changes the current session tags reactivityKeys with session
      Given a signed-in user "alice"
      When "<mutation>" is performed
      Then the mutation runs with "reactivityKeys: [\"session\"]"
      And "sessionAtom" refetches automatically, without application code calling a manual refetch

      Examples:
        | mutation            |
        | role assignment     |
        | accepting an invite |

    @REQ-EA-505
    Scenario: sessionAtom is declared with the reactivityKeys that make automatic refetch possible
      Given "sessionAtom" is declared as "AuthClient.query(\"session\", \"current\", { reactivityKeys: [\"session\"] })"
      When any mutation tagged with "reactivityKeys: [\"session\"]" completes
      Then "sessionAtom" refetches automatically as a consequence of the shared reactivity key

  # BEH-EA-179 — spec/behaviors/23-react.md
  @BEH-EA-179
  Rule: QadiProvider is fed by the session's subject field

    # @skip: blocked by PV-263: the implementation does not derive the subject from sessionAtom's
    # value alone; subjectAtom gates on sessionAtom but takes roles/permissions from a second fetch,
    # GET /subject (EAR-002, AuthClientAtom.ts). Covered by packages/react/test/SubjectAtom.test.ts
    @skip
    @REQ-EA-506
    Scenario: subject is derived from sessionAtom's current value, not a second fetch
      Given "sessionAtom" currently holds a session for "alice" with roles and permissions
      When the provider tree computes qadi's "subject" prop via "toSubject(sessionAtom's value)"
      Then "subject" reflects "alice"'s roles and permissions from "sessionAtom"
      And no second, independently fetched source is queried to produce "subject"

    @REQ-EA-507
    Scenario: Sign-out clears subject to undefined in the same render as the session update
      Given a signed-in user "alice" with "subject" currently defined
      When "alice" signs out and "sessionAtom" becomes "undefined"
      Then "subject" becomes "undefined" in that same render

    # @skip: needs mounted React gates (Can): @testing-library/react and react-dom are not
    # dependencies of features/; the registry-level half (subject clears with the session) is
    # REQ-EA-507; gates are covered by packages/react/test/Providers.test.tsx
    @skip
    @REQ-EA-508
    Scenario: Every mounted gate closes at once when subject becomes undefined
      Given several "Can" gates mounted for "alice", each currently rendering an allowed action
      When "alice" signs out and "subject" becomes "undefined" in the same render
      Then every one of those gates closes at once
      And no gate continues granting access on a stale, no-longer-current "subject"

  # BEH-EA-180 — spec/behaviors/23-react.md
  @BEH-EA-180
  Rule: A stale decision is not a decision

    # @skip: qadi-owned gate behavior (Can pending): needs a rendered React tree, and @qadi/react is
    # exercised by its own suite (../qadi/packages/react/test); @awthaq/react adds no wrapper
    # (BEH-EA-184, packages/react/src/index.ts re-exports it verbatim)
    @skip
    @REQ-EA-509
    Scenario: Can renders the pending state while a policy re-evaluation is in flight
      Given qadi's evaluator is re-evaluating "canDeleteProject" for "alice" against "resource"
      When "<Can policy={canDeleteProject} resource={resource} pending={<Spinner />}>" renders during that in-flight evaluation
      Then the "pending" state is rendered
      And the previous verdict is not rendered in its place

    # @skip: qadi-owned gate behavior (no stale Allow while re-evaluating): needs a rendered React
    # tree; covered by @qadi/react's own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-510
    Scenario: A just-revoked permission does not render a stale allow while re-evaluating
      Given qadi's evaluator previously returned an Allow decision for "canDeleteProject" for "alice"
      And "alice"'s permission has just been revoked, triggering re-evaluation
      When "DeleteButton" is gated by "Can" during that re-evaluation
      Then the "pending" state is rendered instead of the stale Allow verdict
      And "DeleteButton" is not shown on the strength of the superseded decision

    # @skip: qadi-owned hook (currentDecision): needs a rendered React tree; covered by
    # @qadi/react's own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-511
    Scenario: Reading authorization state through currentDecision reflects the same pending state as a gate
      Given a policy re-evaluation in flight for "alice"
      When application code reads the decision via "currentDecision" instead of rendering "Can" directly
      Then "currentDecision" reflects the "pending" state
      And application code never reads the raw async result of a manual query to determine authorization state

  # BEH-EA-181 — spec/behaviors/23-react.md
  @BEH-EA-181
  Rule: useInvalidate re-decides every mounted gate

    # @skip: qadi-owned hook (useInvalidate): needs a rendered React tree; covered by @qadi/react's
    # own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-512
    Scenario Outline: useInvalidate re-decides every mounted gate after a mutation that changes what the subject may do
      Given a mounted "Can" gate that previously decided "Deny" for "alice"
      When "<mutation>" completes and "useInvalidate()" is called
      Then the gate re-runs its decision against the refreshed subject

      Examples:
        | mutation                  |
        | accepting an invite       |
        | being granted a role      |

    # @skip: qadi-owned hook behavior (a gate without useInvalidate keeps its stale decision): needs
    # a rendered React tree; covered by @qadi/react's own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-513
    Scenario: Omitting useInvalidate leaves a mounted gate showing its stale decision until it remounts
      Given a mounted "Can" gate that previously decided "Deny" for "alice"
      When "alice" accepts an invite that changes what she may do, and "useInvalidate()" is not called
      Then the gate keeps showing its stale "Deny" decision
      And it only reflects the new grant if it happens to remount

  # BEH-EA-182 — spec/behaviors/23-react.md
  @BEH-EA-182
  Rule: useProjected trims what a component can render

    # @skip: qadi-owned hook (useProjected): needs a rendered React tree; covered by @qadi/react's
    # own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-514
    Scenario: useProjected returns only the fields the current decision grants
      Given qadi's evaluator would return an Allow decision for "canReadProject" against "resource", granting a subset of its fields
      When a component reads "useProjected(canReadProject, resource)"
      Then the returned view contains only the fields the decision grants

    # @skip: qadi-owned hook (useProjected withholds the field from the data): needs a rendered
    # React tree; server-side projection is wired in 24-nextjs-ssr.feature (REQ-EA-529/530)
    @skip
    @REQ-EA-515
    Scenario: A withheld field is absent from useProjected's data, not merely hidden in JSX
      Given a field of "resource" that the current decision does not grant
      When the component renders using "useProjected(canReadProject, resource)"
      Then that field is absent from the returned data itself
      And it is never present in rendered component props merely hidden by conditional JSX

    # @skip: application-authoring guidance about component source (read the projected view, not the
    # full resource): no library behavior to observe
    @skip
    @REQ-EA-516
    Scenario: A component does not read the full resource object and conditionally hide fields in JSX
      Given a component rendering fields conditioned on "canReadProject"
      When the component is implemented
      Then it reads the projected view via "useProjected"
      And it does not read the full "resource" object and hide ungranted fields with conditional JSX

  # BEH-EA-183 — spec/behaviors/23-react.md
  @BEH-EA-183
  Rule: Typed errors drive the sign-in form, not strings

    @REQ-EA-517
    Scenario: The sign-in form branches on the failure's _tag to render its message
      Given a sign-in mutation fails with a result whose "cause._tag" is "InvalidCredentials"
      When the sign-in form reacts to that failure
      Then it renders "Wrong email or password."
      And the branch was selected by checking "result.cause._tag === \"InvalidCredentials\""

    # @skip: application-authoring guidance about form code: a copy edit cannot change a branch that
    # is selected by _tag (REQ-EA-517 shows the failure carries the typed _tag); no library behavior
    # to observe
    @skip
    @REQ-EA-518
    Scenario: A copy edit to the error's message text does not change which branch renders
      Given the same failure with "cause._tag" of "InvalidCredentials", but with its associated message text changed by a copy edit or localization pass
      When the sign-in form reacts to that failure
      Then the same "InvalidCredentials" branch renders as before
      And the branch choice is unaffected by the message text change

    # @skip: application-authoring guidance about form source (do not match on message strings): no
    # library behavior to observe
    @skip
    @REQ-EA-519
    Scenario: The form does not pattern-match on the error message string to decide what to render
      Given a mutation failure with a typed "_tag"
      When the form's failure-handling code is inspected
      Then it branches on "_tag"
      And it does not pattern-match on the error's message string to select a UI branch

  # BEH-EA-184 — spec/behaviors/23-react.md
  @BEH-EA-184
  Rule: One evaluation path across server, client, and tests

    # @skip: qadi-owned evaluator routing (RequirePermission/guard/enforce/Can/useCan): the
    # server-side pipeline is wired in 19-qadi-bridge-path-a.feature; the client half needs a
    # rendered React tree; @qadi/react is covered by its own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-520
    Scenario: Every gate and helper resolves the same policy through the same qadi evaluator
      Given qadi's evaluator would return an Allow decision for policy "canDeleteProject" against subject "alice"
      When the decision is resolved through "RequirePermission", "guard", "enforce", "Can", and "useCan" for the same policy and subject
      Then each of them resolves via a call to qadi's evaluator
      And none of them produces a decision without calling that evaluator

    # @skip: qadi-owned gate behavior (no client-side role shortcut): needs a rendered React tree;
    # covered by @qadi/react's own suite (../qadi/packages/react/test)
    @skip
    @REQ-EA-521
    Scenario: A simple role-based policy is not special-cased as a client-side shortcut
      Given qadi's evaluator would return a Deny decision for a policy checking "hasRole(\"admin\")" against subject "alice"
      When a React gate renders that policy for "alice"
      Then the gate's rendered verdict reflects qadi's evaluator's Deny decision
      And no client-only shortcut bypasses that evaluator call to render an Allow verdict instead
