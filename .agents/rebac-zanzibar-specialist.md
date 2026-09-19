---
name: rebac-zanzibar-specialist
title: ReBAC / Zanzibar-style Specialist
type: archetype
ecosystem: Authorization
---

# ReBAC / Zanzibar-style Specialist

## Role

This specialist designs relationship-based authorization systems modeled on Google's Zanzibar paper: permissions expressed as tuples over a relationship graph (subject, relation, object), with checks resolved by graph traversal rather than static role lookup. The work includes tuple schema design, choosing consistency models (new-enough reads vs strict consistency), and keeping check latency acceptable as the relationship graph grows.

## Why relevant to effect-auth

`packages/organization`'s nested org/team model is a natural relationship graph — user-in-team, team-in-org, org-has-parent-org — and effect-auth's decision to delegate all authorization to qadi means a Zanzibar-style relationship model, if adopted, would live in qadi while effect-auth supplies the underlying relationship facts (team membership, org hierarchy) as source data. A specialist would assess whether effect-auth's organization data model can cleanly export relationship tuples without qadi needing to reach back into effect-auth's SQL schema directly.

## Core expertise

- Tuple-based relationship modeling (subject-relation-object) and schema design for it
- Graph traversal strategies for permission checks (union, intersection, exclusion, tupleset-to-userset rewrites)
- Consistency tradeoffs: zookie/revision-token patterns for "new enough" reads versus strict global consistency
- Write-path design for relationship tuples that stays consistent with the source system of record
- Check-latency optimization for deeply nested relationship graphs

## Hiring rubric

**Must demonstrate**
- Can describe the subject-relation-object tuple model and give a concrete example from a nested org/team structure
- Understands why naive real-time consistency for every check is often too costly, and what a bounded-staleness read model buys you

**Strong signal**
- Has implemented or integrated with a Zanzibar-style system (Ory Keto, SpiceDB, Google Zanzibar-inspired custom build) including its consistency token handling
- Can explain how to keep a relationship graph synchronized with an external source of truth (like an org membership table) without dual-write drift

**Red flags**
- Proposes recomputing the entire relationship graph on every check with no caching or precomputation strategy
- Has no answer for consistency tradeoffs and defaults to "just always read strongly consistent," ignoring latency cost

## Interview probes

- Model effect-auth's nested organization/team hierarchy as Zanzibar-style tuples, including how "member of parent org implies member of child team" would be expressed.
- How do you prevent a relationship-graph authorization store from drifting out of sync with effect-auth's own organization tables, which remain the system of record?
- Explain a zookie/revision-token approach to avoiding the "new enough" read problem, and when strict consistency is worth the latency cost anyway.
