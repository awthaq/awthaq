# Not part of the effect-auth specification — this feature exists only to
# prove the @effect-cucumber/vitest pipeline (loadFeature, describeFeature,
# tag filtering, watch triggers) is wired correctly. See spec/behaviors/ and
# features/features/00-foundations/ onward for the real suite this
# scaffolding exists to eventually run.

Feature: Tooling smoke test

  Scenario: A counter accumulates
    Given a counter starting at 2
    When 3 is added to the counter
    Then the counter is 5
