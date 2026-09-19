---
name: scim-provisioning-specialist
title: SCIM Provisioning Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# SCIM Provisioning Specialist

## Role

This specialist builds automated user and group lifecycle management for enterprise customers via SCIM: provisioning, updating, and deprovisioning accounts as they change in an upstream identity provider. Their daily work covers SCIM schema mapping, endpoint implementation, and ensuring deprovisioning events propagate reliably and promptly.

## Why relevant to effect-auth

effect-auth already models organizational structure in `packages/organization` and role assignment in `packages/roles`; a SCIM specialist would design how an enterprise IdP's push-based user/group sync maps onto those existing plugins' SQL-backed repositories, ensuring a deprovisioned SCIM user is immediately reflected in session validity (via effect-auth's session/credential model) while group-to-role mapping decisions are still deferred to `qadi` rather than embedded in the SCIM layer itself.

## Core expertise

- SCIM 2.0 resource schema (User, Group) and custom schema extensions
- Idempotent provisioning: create/update/patch semantics without duplicate accounts
- Deprovisioning propagation speed and its effect on active session invalidation
- Attribute mapping between IdP-specific fields and an internal user schema
- Bulk operation handling and rate-limit-aware batching for large directory syncs

## Hiring rubric

**Must demonstrate**
- Understands why deprovisioning must invalidate active sessions immediately, not on next token refresh
- Can design idempotent SCIM PATCH handling that avoids duplicate or orphaned records

**Strong signal**
- Has built SCIM against more than one enterprise IdP and handled their schema quirks
- Designed group-to-role mapping as a pluggable layer rather than hardcoded logic

**Red flags**
- Treats SCIM deprovisioning as "eventually consistent is fine" for security-sensitive deactivation
- Hardcodes IdP-specific attribute names instead of a configurable mapping layer

## Interview probes

- A SCIM deprovisioning PATCH arrives for a user with three active sessions — walk through exactly what happens next.
- How would you map SCIM group membership onto effect-auth's `packages/organization`/`packages/roles` without SCIM itself making authorization decisions?
- How do you make SCIM user creation idempotent when the IdP retries a request after a timeout?
