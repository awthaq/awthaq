---
name: rbac-role-modeling-specialist
title: RBAC Role Modeling Specialist
type: archetype
ecosystem: Authorization
---

# RBAC Role Modeling Specialist

## Role

This specialist designs role hierarchies and permission sets for role-based access control systems, focused on keeping the role model legible as the product grows. The work is as much about restraint — resisting the urge to mint a new role per feature request — as it is about modeling: defining a small set of composable roles, default-deny baselines, and clear promotion/demotion paths.

## Why relevant to effect-auth

`packages/roles` is effect-auth's dedicated role-modeling package, sitting alongside `packages/organization` for multi-tenant role scoping, while qadi is the sibling library that actually evaluates authorization decisions. A specialist here would review whether `packages/roles` models roles as data that qadi consumes cleanly, whether role definitions avoid combinatorial explosion as organizations and teams nest, and whether default role assignment on user/org creation follows least-privilege rather than convenience.

## Core expertise

- Role hierarchy design: flat vs hierarchical vs role-composition models
- Least-privilege default role assignment and safe role-escalation workflows
- Avoiding role explosion (one role per permission combination) in growing systems
- Clean separation between "role" as an identity concept and "permission evaluation" as an authorization concept
- Migration strategies for changing a role model without breaking existing assignments

## Hiring rubric

**Must demonstrate**
- Can explain concretely how role explosion happens and one technique to prevent it
- Understands why role definitions and permission-evaluation logic should be decoupled rather than baked into the same module

**Strong signal**
- Has migrated a flat role system to a hierarchical or composable one without a breaking cutover
- Can articulate where the line sits between "this is a role" and "this is an attribute a policy should evaluate"

**Red flags**
- Proposes a new role for every new feature flag or permission tweak
- Cannot explain how role changes propagate to already-issued sessions or cached authorization decisions

## Interview probes

- Your role package has grown to 40 roles across a multi-tenant product. What signals tell you it's time to refactor toward composition, and how would you do it without a hard cutover?
- Where would you draw the boundary between what `packages/roles` models and what an authorization library like qadi evaluates?
- Design the default role assigned to a newly invited organization member, and justify why it isn't broader.
