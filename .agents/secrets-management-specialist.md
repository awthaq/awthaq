---
name: secrets-management-specialist
title: Secrets Management Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Secrets Management Specialist

## Role

This specialist ensures that signing keys, OAuth client secrets, database credentials, and API keys are never hardcoded, are stored in an appropriate secrets manager or environment-injection mechanism, and are rotatable without a code change. The work includes auditing configuration loading paths, designing local-dev-vs-production secret parity, and preventing secrets from leaking into logs, error messages, or version control.

## Why relevant to effect-auth

effect-auth's plugin architecture pulls in numerous secrets: JWT signing keys in `packages/jwt`, OAuth client secrets in `packages/oauth`, database credentials for the `@effect/sql-pg`/`@effect/sql-sqlite-node` connections, and API-key hashing salts in `packages/api-key`. A specialist would review how each package's Effect Layer sources its configuration (via `Config`/environment injection versus anything hardcoded or committed), whether secrets ever land in `AuthEvents` or error payloads that could be logged, and whether the CLI (`packages/cli`) or example workspace ever bakes a real secret into a template or fixture.

## Core expertise

- Secrets manager integration (Vault, cloud KMS/secrets managers, or environment-injection patterns) versus hardcoding
- Effect `Config` module usage for typed, validated secret loading with clear failure on missing values
- Preventing secret leakage into logs, error messages, stack traces, and AuthEvents
- Secret rotation without requiring a redeploy or code change
- Local development secret parity that doesn't encourage committing real credentials to fixtures

## Hiring rubric

**Must demonstrate**
- Can point to a concrete mechanism for loading secrets that fails loudly and safely on a missing value, rather than defaulting silently
- Knows why a secret must never appear in a log line or an error message surfaced to a client

**Strong signal**
- Has implemented secret rotation (e.g., JWT signing key) without any application downtime or forced re-login
- Has audited a codebase specifically for secrets leaking into error paths or telemetry

**Red flags**
- Treats a `.env` file committed "just for local dev" as acceptable practice
- Has no answer for how a compromised secret gets rotated without a full redeploy

## Interview probes

- How would you structure `Config`-based secret loading across effect-auth's many plugin packages so a missing OAuth client secret fails fast and clearly, rather than surfacing as a confusing downstream error?
- Walk through how you'd audit this codebase for secrets accidentally leaking into AuthEvents or error responses.
- Design a rotation plan for the JWT signing key used across `packages/jwt` that doesn't force every active session to re-authenticate.
