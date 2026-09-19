---
name: effect-http-api-specialist
title: Effect HTTP API Specialist
type: archetype
ecosystem: Effect
---

# Effect HTTP API Specialist

## Role

This specialist designs HTTP surfaces using Effect's HttpApi and HttpApiMiddleware primitives: endpoint groups, security schemes, and the request/response contracts that bind Schema definitions to wire behavior. Day to day work includes reviewing new endpoint definitions for correct status-code mapping, middleware ordering, and consistent error serialization.

## Why relevant to effect-auth

The `packages/api` and `packages/server` packages expose effect-auth's session, credential, OAuth, passkey, and admin operations over HTTP via HttpApi, with HttpApiMiddleware handling concerns like session extraction and CSRF/security-scheme enforcement before a request reaches plugin logic. Because every plugin package can contribute its own endpoint group, this role is responsible for keeping the composed HttpApi contract consistent (uniform auth requirements, uniform error encoding via Schema.TaggedError) even though the underlying routes are assembled from many independently developed plugins.

## Core expertise

- HttpApi/HttpApiGroup/HttpApiEndpoint composition across plugin-contributed route groups
- HttpApiMiddleware and HttpApiSecurity for session/bearer/API-key authentication schemes
- Mapping typed domain errors to HTTP status codes and consistent error response shapes
- Request/response contract testing against the generated OpenAPI surface
- CORS, CSRF, and cookie-handling concerns specific to session-based auth flows
- Client-server contract sharing so `packages/client` stays type-safe against the served API

## Hiring rubric

**Must demonstrate**
- Can design an HttpApiMiddleware that authenticates a request and provides a typed context service to downstream handlers
- Understands the difference between a security-scheme-level failure (401) and a domain-level failure (403, validation errors)

**Strong signal**
- Has composed multiple independently-defined HttpApiGroups into one API without endpoint or tag collisions
- Designs error encoding so client and server share the same Schema-derived error taxonomy end to end

**Red flags**
- Hand-rolls status-code logic in individual handlers instead of centralizing it in error-to-response mapping
- Treats middleware ordering as unimportant when multiple plugins each register their own middleware

## Interview probes

- "A passkey plugin and an API-key plugin both need to authenticate requests on overlapping routes — how do you compose their HttpApiMiddleware so precedence is unambiguous?"
- "How would you ensure a new plugin's endpoint group can't silently override an existing route path or tag?"
- "Walk through how a Schema.TaggedError raised deep in a plugin's business logic ends up as a specific HTTP status and JSON body."
