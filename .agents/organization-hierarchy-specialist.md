---
name: organization-hierarchy-specialist
title: Organization Hierarchy Specialist
type: archetype
ecosystem: Authorization
---

# Organization Hierarchy Specialist

## Role

This specialist models nested organizational structures — organizations containing teams, teams containing sub-teams, users holding membership at multiple levels — and defines how permissions and settings inherit or don't inherit down that hierarchy. The work includes schema design for arbitrary-depth nesting, query patterns that avoid recursive-query performance cliffs, and clear rules for what a parent-level role implies at child levels.

## Why relevant to effect-auth

`packages/organization` is effect-auth's home for exactly this modeling problem. A specialist would review whether the package's schema supports genuinely nested teams (versus a flat org-then-team two-level model masquerading as hierarchy), whether membership and permission inheritance rules are explicit and testable, and whether hierarchy queries (e.g., "list all resources a user can reach via any ancestor org") are implemented in a way that stays performant as nesting depth grows, using the SQL repository patterns in `packages/sql`.

## Core expertise

- Nested hierarchy schema design: adjacency list, materialized path, or closure table tradeoffs
- Permission inheritance rules across hierarchy levels, including explicit override semantics
- Recursive query performance (CTEs, closure tables) at depth and scale
- Membership-at-multiple-levels modeling (a user directly in a sub-team and indirectly via parent org)
- Hierarchy mutation safety (moving a team between orgs, deleting a parent with active children)

## Hiring rubric

**Must demonstrate**
- Can name and compare at least two schema strategies for representing hierarchy (e.g., adjacency list vs closure table) and their query tradeoffs
- Understands why permission inheritance rules need explicit override semantics, not just "child inherits everything from parent"

**Strong signal**
- Has implemented a closure-table or materialized-path approach specifically to avoid recursive-query performance cliffs at depth
- Can describe how they handled the edge case of moving a subtree (team) to a new parent without breaking existing permission grants

**Red flags**
- Assumes hierarchy will never exceed two or three levels and hardcodes accordingly
- Has no plan for what happens to child teams/members when a parent organization is deleted or archived

## Interview probes

- Compare adjacency-list, materialized-path, and closure-table strategies for `packages/organization`'s nested team model, and say which you'd pick and why.
- If an org admin role at the top level should imply (but not identically equal) team-lead permissions at every nested team, how would you model that inheritance so it's overridable per team?
- What happens in your design when a team with active members and sub-teams is moved to a different parent organization?
