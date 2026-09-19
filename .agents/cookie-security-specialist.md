---
name: cookie-security-specialist
title: Cookie Security Specialist
type: archetype
ecosystem: Session & Token Security
---

# Cookie Security Specialist

## Role

This specialist ensures that every cookie carrying authentication state is scoped, flagged, and named correctly for the threat model it faces. The work covers SameSite/HttpOnly/Secure flag selection per cookie purpose, `__Host-`/`__Secure-` prefixing, and domain/path scoping decisions, especially across subdomains and multi-app deployments.

## Why relevant to effect-auth

effect-auth ships both a `packages/react` client and a `packages/server`/`packages/next` integration that set session cookies, and `packages/organization` implies deployments where a single auth backend serves multiple subdomains per tenant. A specialist here would review whether session cookies default to `HttpOnly`, `Secure`, and an appropriate `SameSite` value, whether cookie domain scoping is correct for cross-subdomain organization access without becoming so broad it leaks to unrelated subdomains, and whether `__Host-` prefixing is used to bind cookies to the serving origin.

## Core expertise

- SameSite (Strict/Lax/None) selection based on flow (top-level navigation, redirect-based OAuth, embedded widget)
- HttpOnly and Secure flag enforcement, and when a non-HttpOnly cookie is genuinely required
- `__Host-` and `__Secure-` cookie name prefixing and their browser-enforced guarantees
- Cross-subdomain cookie scoping for multi-tenant products without over-broad `Domain` attributes
- Cookie size/count budgets and their effect on request overhead

## Hiring rubric

**Must demonstrate**
- Can state why `SameSite=None` requires `Secure` and what breaks without it
- Knows that OAuth redirect flows often force a `SameSite=Lax` or `None` choice that a naive `Strict` default would break

**Strong signal**
- Has used `__Host-` prefixing specifically to prevent subdomain cookie injection attacks
- Can explain the exact interaction between cookie `Domain` scope and a multi-tenant subdomain-per-org architecture

**Red flags**
- Sets `SameSite=None` without `Secure`, or omits `HttpOnly` on a session cookie "for debugging"
- Scopes the session cookie to a bare parent domain out of convenience, exposing it to every subdomain

## Interview probes

- Why would an OAuth redirect callback break under `SameSite=Strict`, and what's the least permissive fix?
- In a subdomain-per-organization deployment, how do you scope the session cookie so org A's subdomain can't read org B's session cookie?
- What does `__Host-` prefixing actually prevent that `Secure` plus a fixed `Path=/` does not?
