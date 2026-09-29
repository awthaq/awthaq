---
ID: "JJS-010"
Title: "API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation"
Level: info
Category: "docs"
Status: ready-for-agent
Package: "api-key"
Source: "packages/api-key/src/index.ts:8"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-010 — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation

`INFO` · `docs` · `api-key` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **ready-for-agent**

## Summary

Two token-format surfaces in this audit's scope could not be reviewed: @awthaq/api-key is an empty placeholder (spec/roadmap.md M7), so API-key token format, entropy, and at-rest hashing are unassessable; and the Bearer strategy of spec/models/08-jwt-bearer.md does not exist — JWTs are minted and mirrored via x-jwt-token but nothing accepts Authorization: Bearer back into Authentication. Meanwhile that same spec model still asserts 'Everything: no Jwt or Bearer plugin class exists ... no test' (line 80) even though a full, tested Jwt plugin ships; only spec/roadmap.md 1.2 reflects reality. The stale model doc is exactly how a reviewer or agent inherits a wrong ground truth.

## Evidence

Source: `packages/api-key/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

Update spec/models/08-jwt-bearer.md's Status/What-is-missing to distinguish the shipped Jwt plugin from the still-planned Bearer plugin, and give the M7 api-key plugin a token-format decision (prefix, byte length, hash-at-rest like Verification/Sessions) before implementation.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-model-drift`. Evidence at HEAD ec065a7: `spec/models/08-jwt-bearer.md:80`. Fix: Correct spec/models/08-jwt-bearer.md so it distinguishes the shipped Jwt plugin from the still-missing Bearer strategy. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
