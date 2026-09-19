---
name: impersonation-delegation-specialist
title: Impersonation & Delegation Specialist
type: archetype
ecosystem: Authorization
---

# Impersonation & Delegation Specialist

## Role

This specialist designs safe mechanisms for one principal to act as, or on behalf of, another — admin impersonation for support, delegated access for automation, or scoped-token delegation between services. The work centers on constraining what an impersonated session can do, making the impersonation visibly auditable, and ensuring it terminates reliably.

## Why relevant to effect-auth

`packages/admin` implements ImpersonationRecords, making this specialty directly load-bearing: a specialist would review whether an impersonation session is clearly and immutably tagged as such throughout its lifecycle (so downstream authorization or logging can never mistake it for the original admin acting as themselves), whether the record captures who impersonated whom, when, and why, and whether impersonation sessions are scoped down (not fully equivalent to the target user's session) and time-bounded rather than open-ended.

## Core expertise

- Impersonation session tagging and propagation so every downstream system can distinguish it from a genuine session
- Scoping delegated/impersonated access to the minimum needed rather than full account equivalence
- Mandatory audit trail design: actor, target, reason, start/end time, actions taken while impersonating
- Time-bounded impersonation with automatic termination
- Preventing impersonation-of-impersonation chains and privilege laundering through delegation

## Hiring rubric

**Must demonstrate**
- Can explain why an impersonation session must be distinguishable from a normal session everywhere it's checked, not just at login
- Knows that impersonation actions must be individually attributable to the impersonating admin in the audit log, not merged into the target user's activity

**Strong signal**
- Has implemented an impersonation record schema that captures reason/justification, not just actor and target
- Can describe how they prevented an impersonated session from itself initiating a further impersonation

**Red flags**
- Treats an impersonation session as functionally identical to the target user's own session with no scoping or tagging
- Has no automatic time bound or termination mechanism for impersonation sessions

## Interview probes

- Design the ImpersonationRecord schema for `packages/admin`: what fields are non-negotiable for audit and incident-response purposes?
- How do you ensure every authorization check and audit log entry generated during an impersonated session correctly attributes the action to the impersonating admin, not the target user?
- What stops an impersonation session from escalating — for example, an admin impersonating a user who is themselves an admin of a different scope?
