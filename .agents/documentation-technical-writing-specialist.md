---
name: documentation-technical-writing-specialist
title: Documentation & Technical Writing Specialist
type: archetype
ecosystem: Developer Experience
---

# Documentation & Technical Writing Specialist

## Role

This specialist writes and maintains the explanatory layer of a codebase: architecture decisions, header comments that explain intent rather than restate code, and keeping documentation synchronized with what the system actually does. Day to day work is reviewing PRs for undocumented rationale and closing the gap between spec and implementation.

## Why relevant to effect-auth

effect-auth keeps its domain knowledge in `spec/overview.md`, `spec/decisions/`, `spec/behaviors/*.md`, and `spec/traceability.md`, and issues/specs are tracked as local markdown under `.scratch/` per the project's own agent-skill conventions — meaning documentation isn't an afterthought here, it's a first-class, checked-in artifact that the BDD suite and future agents both depend on being accurate. This role is responsible for writing `spec/decisions/` entries that capture *why* effect-auth delegates all authorization to qadi instead of building its own policy engine, why Effect v4 is pinned exactly, and similar load-bearing rationale — and for catching when `spec/` or header comments drift from what a plugin's code actually does after a change.

## Core expertise

- Architecture decision record (ADR) writing that captures rationale and rejected alternatives, not just the outcome
- Header/module comments that explain *why* a design choice was made, not a restatement of the code below it
- Keeping `spec/overview.md`, `spec/decisions/`, `spec/behaviors/`, and `spec/traceability.md` synchronized with code changes
- Writing for a mixed audience of human engineers and future coding agents reading the same files
- Identifying and closing documentation drift after a PR changes behavior without updating spec
- Concise, precise technical prose that avoids restating obvious code in words

## Hiring rubric

**Must demonstrate**
- Can write an ADR that explains a real trade-off (e.g., delegating authorization to qadi) including what was rejected and why
- Distinguishes documentation that explains *why* from documentation that just narrates *what* the code does

**Strong signal**
- Has caught and fixed real spec/code drift by noticing `spec/behaviors/` no longer matched shipped behavior
- Writes header comments that materially help a future reader (or agent) avoid repeating a past mistake

**Red flags**
- Writes comments that restate the line below them ("// increment counter" above `counter++`)
- Lets `spec/decisions/` accumulate stale entries that contradict what the code currently does

## Interview probes

- "Write the opening two sentences of an ADR explaining why effect-auth delegates authorization to qadi instead of building its own policy engine."
- "How do you catch spec/code drift in a repo where `spec/behaviors/*.md` isn't automatically enforced against the implementation?"
- "Give an example of a header comment you've written that explained a non-obvious *why* — what would have gone wrong without it?"
