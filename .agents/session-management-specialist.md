---
name: session-management-specialist
title: Session Management Specialist
type: archetype
ecosystem: Session & Token Security
---

# Session Management Specialist

## Role

This specialist designs and audits the full lifecycle of a session: creation on successful authentication, validation on each request, renewal, and invalidation on logout, timeout, or policy change. Day to day work includes defining session identifier entropy and storage, deciding what state lives server-side versus in the token, and setting concurrent-session and idle-timeout policy.

## Why relevant to effect-auth

effect-auth's `packages/core` owns session creation and validation as the central mechanism through which every plugin (password, oauth, passkey, magic-link, api-key, two-factor) ultimately resolves a principal. A session-management specialist would review how sessions are minted after each of these disparate credential flows converge, how session records are persisted via the SQL repositories in `packages/sql`, and how session fixation is prevented across a plugin boundary where a pre-auth session must never survive into an authenticated one.

## Core expertise

- Session ID generation, entropy requirements, and opaque-vs-signed tradeoffs
- Session fixation and privilege-escalation prevention at the login boundary
- Server-side session store design (SQL, Redis) versus stateless approaches
- Concurrent session limits, device tracking, and "log out everywhere" semantics
- Idle timeout, absolute timeout, and sliding expiration policy
- Effect Layer-based lifecycle modeling for session services

## Hiring rubric

**Must demonstrate**
- Can explain why the session ID must be regenerated on privilege change, not just reused
- Understands the difference between session invalidation and token expiry
- Has implemented or reviewed a "log out from all devices" feature end to end

**Strong signal**
- Has designed a session store schema that supports efficient bulk revocation
- Can articulate tradeoffs between database-backed and in-memory session stores under multi-instance deployment

**Red flags**
- Treats "the session cookie exists" as equivalent to "the session is valid"
- No opinion on what happens to existing sessions when a user's password or MFA is reset

## Interview probes

- Walk through what changes in your session store the moment a user completes step-up authentication mid-session.
- A plugin architecture lets multiple credential types produce a session. How would you guarantee a session minted via magic-link carries the same trust level as one minted via password plus 2FA?
- How would you detect and respond to concurrent sessions from geographically impossible locations without building a full fraud engine?
