---
name: csrf-defense-specialist
title: CSRF Defense Specialist
type: archetype
ecosystem: Session & Token Security
---

# CSRF Defense Specialist

## Role

This specialist designs cross-site request forgery defenses for cookie-authenticated applications, choosing between double-submit cookie patterns and server-side synchronizer tokens, and correctly positioning `SameSite` as one layer among several rather than a complete replacement for CSRF tokens. Day to day work includes auditing state-changing endpoints for CSRF coverage and validating that defenses hold across the app's actual request patterns (fetch, form submit, cross-origin iframe).

## Why relevant to effect-auth

Because effect-auth issues cookie-backed sessions consumed by `packages/react`, `packages/next`, and any API consumer of `packages/api`/`packages/server`, every state-changing auth endpoint — password change, session revocation, organization membership changes — is a CSRF target if only cookie presence is checked. A specialist would verify effect-auth doesn't rely on `SameSite=Lax` alone (which doesn't cover subdomain-based or same-site attacker pages) and that a token-based defense exists for the endpoints that mutate authentication or authorization state.

## Core expertise

- Double-submit cookie pattern implementation and its stateless-verification tradeoffs
- Synchronizer token pattern for server-rendered and SPA flows
- Precise understanding of what `SameSite=Lax/Strict` does and does not defend against
- CSRF risk assessment across GET/POST/mutating-endpoint boundaries
- Token binding to session to prevent CSRF-token fixation

## Hiring rubric

**Must demonstrate**
- Can explain a concrete attack `SameSite=Lax` fails to stop that a CSRF token would
- Knows why the double-submit cookie value must be unpredictable and tied to the session, not just "present"

**Strong signal**
- Has implemented CSRF protection that survives a same-site subdomain compromise scenario
- Can reason about CSRF exposure specifically for JSON APIs consumed by a JS client versus form-posting endpoints

**Red flags**
- States "we use SameSite cookies so we don't need CSRF tokens" as a complete answer
- Applies CSRF protection uniformly to all endpoints without distinguishing state-changing from read-only routes

## Interview probes

- Describe an attack that succeeds against `SameSite=Lax` cookies but fails against a properly implemented double-submit token.
- When would you choose a synchronizer token over a double-submit cookie, and what server-side state does that choice force you to keep?
- How would you protect a JSON API endpoint that a JS client calls via `fetch` with credentials included, where no HTML form exists?
