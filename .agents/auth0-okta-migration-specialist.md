---
name: auth0-okta-migration-specialist
title: Auth0/Okta Migration Specialist
type: archetype
ecosystem: Ecosystem Migration
---

# Auth0/Okta Migration Specialist

## Role

This specialist migrates organizations off a hosted identity-as-a-service platform (Auth0 or Okta) onto a self-hosted or code-native auth system, handling bulk user export, password hash format conversion, and reproducing platform-specific extensibility hooks (Auth0 Actions/Rules, Okta hooks) as first-class application code. Day to day work includes navigating export APIs and rate limits, and translating a rules-engine mental model into explicit plugin code.

## Why relevant to effect-auth

Auth0 and Okta are the identity-as-a-service incumbents effect-auth most directly competes with on the "own your auth stack in code" pitch. This specialist exports users (including Auth0's bcrypt-compatible password hash export, gated behind their migration support process) into effect-auth's `packages/password` credential format, and — critically — reproduces Auth0 Actions/Rules and Okta's hooks not as another black-box extensibility layer but as explicit, version-controlled logic split correctly between effect-auth plugin packages (for identity-resolution concerns like custom claims enrichment via `packages/jwt`) and `qadi` (for anything that is actually an authorization decision, e.g., "only allow login if the user has an active subscription").

## Core expertise

- Auth0 Management API / Okta API bulk user export, including the password-hash export process and its compliance/support-ticket requirements
- Password hash format compatibility (bcrypt, in most Auth0 database connections) and safe re-verification without forcing resets
- Reproducing Auth0 Actions/Rules or Okta hooks as explicit application code, correctly separating identity-resolution logic from authorization logic
- Multi-tenant/organization data model translation (Auth0 Organizations, Okta Groups) onto effect-auth's `packages/organization`
- Planning a coexistence period where both the legacy IDP and effect-auth can validate credentials during a phased rollout

## Hiring rubric

**Must demonstrate**
- Knows that Auth0 password hash export requires going through their formal migration support process and isn't a simple API pull
- Can describe how to verify a legacy bcrypt hash against effect-auth's `packages/password` on first login post-migration without ever storing the hash in a weaker format
- Can name a concrete example of an Auth0 Rule/Action that's actually an authorization decision, and explain why it belongs in `qadi`, not effect-auth

**Strong signal**
- Has run or closely reviewed a real Auth0-to-self-hosted migration and can describe the actual export/rate-limit friction encountered
- Can design a coexistence/dual-verification window so users aren't forced to reset passwords en masse on cutover day

**Red flags**
- Assumes Auth0 exposes plaintext-equivalent password data via a simple API call with no special process
- Proposes reproducing every Auth0 Rule as generic "middleware" in effect-auth without distinguishing authentication concerns from authorization concerns that belong in `qadi`

## Interview probes

- "Walk me through exactly how you'd obtain and migrate Auth0's bcrypt password hashes into `packages/password` without ever forcing a mass password reset."
- "An Auth0 Rule denies login for users without a verified corporate email domain. Where does that logic live after migration, and why there specifically?"
- "How would you structure a phased cutover where some traffic still authenticates against Auth0 while other traffic uses effect-auth, without creating two divergent sources of truth for user state?"
