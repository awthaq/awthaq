---
name: threat-modeling-specialist
title: Threat Modeling Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Threat Modeling Specialist

## Role

This specialist systematically enumerates threats against a system's design before or alongside implementation, typically using a structured framework like STRIDE, and identifies trust boundaries where assumptions change between components. The work produces concrete, prioritized findings rather than generic checklists, and focuses on where a design's assumptions could be violated by a realistic attacker.

## Why relevant to effect-auth

The effect-auth/qadi split is itself a trust boundary worth modeling explicitly: effect-auth asserts "this is who the principal is," and qadi trusts that assertion to decide what they can do — a threat model should ask what happens if that boundary is crossed with a forged or stale principal claim. A specialist would run STRIDE across effect-auth's plugin surface (spoofing via OAuth/passkey/magic-link flows, tampering with session or JWT data, repudiation gaps in AuthEvents, information disclosure across `packages/organization` tenants, denial of service via unthrottled auth endpoints, elevation of privilege via impersonation in `packages/admin`).

## Core expertise

- STRIDE (and comparable) threat-modeling methodology applied to authentication systems specifically
- Trust boundary identification between separately maintained components/libraries
- Data flow diagramming for authentication and authorization request paths
- Prioritizing findings by realistic exploitability and blast radius, not exhaustive theoretical coverage
- Translating threat-model findings into concrete mitigations owned by specific components

## Hiring rubric

**Must demonstrate**
- Can apply STRIDE to a real system and produce specific, non-generic findings tied to actual data flows
- Understands what a trust boundary is and can identify one in an unfamiliar architecture within minutes

**Strong signal**
- Has threat-modeled a system with a similar split-responsibility architecture (one component resolves identity, another decides access) and can speak to what goes wrong at that seam
- Prioritizes findings by realistic attacker cost/benefit rather than listing every theoretically possible threat

**Red flags**
- Produces a generic STRIDE checklist with no connection to the system's actual architecture or data flows
- Treats threat modeling as a one-time exercise with no mechanism to revisit it as the architecture changes

## Interview probes

- Threat-model the trust boundary between effect-auth (resolves the principal) and qadi (decides authorization) using STRIDE. What's the most concerning finding, and why?
- What happens to that trust boundary if effect-auth passes a stale or cached principal claim to qadi? Which STRIDE category does that fall under?
- Pick one effect-auth plugin (say, `packages/oauth` or `packages/passkey`) and identify its most significant spoofing threat and a realistic mitigation.
