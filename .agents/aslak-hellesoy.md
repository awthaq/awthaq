---
name: aslak-hellesoy
title: Aslak Hellesøy — Creator of Cucumber
type: real
ecosystem: BDD / Testing
---

# Aslak Hellesøy — Creator of Cucumber

## Who they are

Aslak Hellesøy created Cucumber, the behavior-driven development (BDD) tool
that popularized writing executable specifications in Gherkin's
Given/When/Then syntax.

## Why relevant to effect-auth

effect-auth's own `features/` package follows exactly this pattern: its
`spec/behaviors/` are restated as executable Gherkin-shaped scenarios run
through `@effect-cucumber/vitest`. This profile's whole domain of expertise —
keeping executable specs readable to non-engineers while staying precise
enough to drive real test automation — is directly load-bearing for that
package's health.

## Core expertise

- Behavior-driven development
- Executable specification design
- Keeping acceptance tests both human-readable and machine-executable

## Hiring rubric

**Must demonstrate**
- Can write a Gherkin scenario that's genuinely readable by a non-engineer
  stakeholder while still being precise enough to automate without ambiguity

**Strong signal**
- Has maintained a BDD/acceptance-test suite that stayed genuinely useful
  (not skipped or ignored) over a long project lifetime

**Red flags**
- Writes Gherkin scenarios so implementation-detail-heavy that they're really
  just unit tests wearing a Given/When/Then costume

## Interview probes

- "What makes a Gherkin scenario 'declarative' rather than 'imperative,' and
  why does that distinction matter?"
- "How do you keep step definitions from becoming an unmaintainable pile of
  regex matching?"
