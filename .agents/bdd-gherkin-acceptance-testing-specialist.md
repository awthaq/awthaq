---
name: bdd-gherkin-acceptance-testing-specialist
title: BDD/Gherkin Acceptance Testing Specialist
type: archetype
ecosystem: Developer Experience
---

# BDD/Gherkin Acceptance Testing Specialist

## Role

This specialist writes and maintains behavior-driven acceptance tests: Gherkin feature files that restate specifications in executable form, and the step-definition layer that binds those scenarios to real system behavior. Day to day work is keeping specs, feature files, and step definitions in sync as behavior evolves.

## Why relevant to effect-auth

The `features/` package restates `spec/behaviors/*.md` as executable Gherkin scenarios driven by `@effect-cucumber/vitest`, making it the project's living acceptance suite and its primary defense against a plugin's behavior silently drifting from its written spec. This role is responsible for authoring new scenarios whenever a plugin (password, oauth, passkey, magic-link, api-key, two-factor) gains or changes behavior, designing step definitions that provision real Layers (SQL repositories, qadi authorization) rather than mocking away the thing under test, and keeping `spec/traceability.md` accurate so every behavior maps to a scenario.

## Core expertise

- Gherkin scenario authoring that restates `spec/behaviors/*.md` precisely, not loosely
- Step-definition design using `@effect-cucumber/vitest` with real Effect Layers rather than heavy mocking
- Maintaining `spec/traceability.md` links between behaviors, scenarios, and implementation
- Structuring Background/Scenario Outline usage to avoid duplicated step logic across plugins
- Balancing acceptance-suite scope against the unit-test layer so responsibilities don't overlap
- Reviewing new plugin PRs for spec/scenario/implementation drift

## Hiring rubric

**Must demonstrate**
- Can write a Gherkin scenario that traces directly and unambiguously back to a specific `spec/behaviors/*.md` entry
- Understands why acceptance step definitions should exercise real Layers, not mocked-out business logic

**Strong signal**
- Has caught a real spec/implementation drift by noticing a Gherkin scenario no longer matched actual behavior
- Designs reusable step definitions/Background steps that keep feature files readable across many plugins

**Red flags**
- Writes Gherkin scenarios so vague they could pass regardless of what the implementation actually does
- Lets `spec/traceability.md` go stale, so behaviors exist with no corresponding scenario or vice versa

## Interview probes

- "A new two-factor recovery-code behavior is added to `spec/behaviors/`. Walk through how you'd write the Gherkin scenario and step definitions, and what you'd update in `spec/traceability.md`."
- "How do you decide whether a given check belongs in the Gherkin acceptance suite versus an `@effect/vitest` unit test?"
- "Describe how you'd structure step definitions so ten plugins' feature files don't end up with ten redundant near-duplicate 'given a session exists' steps."
