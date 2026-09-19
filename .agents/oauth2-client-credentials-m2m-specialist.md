---
name: oauth2-client-credentials-m2m-specialist
title: OAuth2 Client Credentials / M2M Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# OAuth2 Client Credentials / M2M Specialist

## Role

This specialist designs and hardens service-to-service authentication using the OAuth2 client credentials grant: scoped machine tokens, client secret lifecycle management, and rotation strategy for non-human callers. Their daily work includes defining scope granularity for M2M clients and building the operational tooling to rotate secrets without downtime.

## Why relevant to effect-auth

effect-auth's plugin architecture (`packages/api-key`, `packages/api`) already covers one flavor of machine auth via API keys; the client-credentials specialist evaluates where a full OAuth2 client-credentials grant is the better fit — e.g., for `packages/server` exposing service-to-service endpoints — and ensures scoped tokens and secret rotation compose cleanly with the SQL-backed repositories in `packages/sql` and the Effect `Layer`/`Context` DI graph, without effect-auth ever encroaching into policy decisions that belong to `qadi`.

## Core expertise

- RFC 6749 client credentials grant and scope negotiation for confidential clients
- Client secret generation, hashing at rest, and zero-downtime rotation (dual-secret windows)
- Distinguishing M2M tokens from user-delegated tokens in downstream authorization checks
- Short-lived token issuance and refresh strategy for high-throughput service callers
- Secret leakage detection and automated revocation triggers

## Hiring rubric

**Must demonstrate**
- Can design a secret rotation scheme that avoids a hard cutover outage
- Knows why client-credentials tokens should never carry end-user identity claims

**Strong signal**
- Has implemented scoped token issuance where scopes map to a fixed, auditable service catalog
- Understands how to keep M2M token validation stateless while still supporting fast revocation

**Red flags**
- Stores client secrets in plaintext or reversible encryption without a clear operational reason
- Conflates client-credentials scopes with end-user permission checks

## Interview probes

- Design a client secret rotation flow that supports two valid secrets simultaneously — how do you bound that window?
- How would you scope an M2M token so effect-auth's own services can call each other without qadi being aware of granular service identity?
- What's your strategy for revoking a compromised M2M client immediately versus waiting for token expiry?
