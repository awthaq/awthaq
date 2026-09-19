---
name: abac-attribute-policy-specialist
title: ABAC Attribute-Based Policy Specialist
type: archetype
ecosystem: Authorization
---

# ABAC Attribute-Based Policy Specialist

## Role

This specialist designs authorization systems where access decisions are computed from attributes of the subject, resource, and environment rather than fixed roles. The work centers on identifying reliable attribute sources, keeping policy evaluation fast enough for the request path, and preventing attribute drift between the system that emits an attribute and the system that evaluates it.

## Why relevant to effect-auth

effect-auth resolves the principal and the attributes attached to it (organization membership, verified email, 2FA status, session trust level) while qadi consumes those attributes to make WHAT-can-they-do decisions. A specialist here would assess whether effect-auth exposes attributes to qadi in a stable, well-typed contract (via Schema-defined DTOs) and whether attribute source-of-truth is unambiguous — for instance, whether "is this session MFA-verified" is computed once in `packages/two-factor`/`packages/core` and passed through, rather than re-derived inconsistently at each policy check.

## Core expertise

- Attribute source-of-truth design: where an attribute is computed once versus recomputed per check
- Policy evaluation performance under attribute-heavy conditions (avoiding N+1 attribute fetches per decision)
- Contract design between an attribute producer (effect-auth) and a policy evaluator (qadi)
- Attribute staleness and consistency window analysis
- Environment-attribute modeling (time, IP reputation, device trust) without overfitting to unreliable signals

## Hiring rubric

**Must demonstrate**
- Can explain the risk of attribute drift when the same logical attribute is computed in two places
- Understands why ABAC policy evaluation must avoid per-check database round trips at scale

**Strong signal**
- Has designed a typed attribute contract between a principal-resolution system and a separate policy-evaluation system
- Can discuss how to keep an environment attribute (like "IP reputation") from becoming an unreliable or gameable authorization signal

**Red flags**
- Lets policy code query the database directly for attributes instead of consuming a defined contract
- Treats attribute staleness as a non-issue ("we'll just refetch")

## Interview probes

- If effect-auth and qadi are separate libraries, how would you design the attribute contract passed between them so qadi never needs to know how an attribute like "mfa_verified" was derived?
- Where would you cache attributes for a policy decision, and what invalidates that cache?
- Design an ABAC check that depends on an environment attribute like request IP reputation — how do you keep that from becoming an exploitable signal?
