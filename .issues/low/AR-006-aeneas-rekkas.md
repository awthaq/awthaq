---
ID: "AR-006"
Title: "Machine principals in the wire union are unreachable — the M2M half of the API story is a stub"
Level: low
Category: "api"
Status: resolved
Package: "api-key"
Source: "packages/api-key/src/index.ts:8"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-006 — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub

`LOW` · `api` · `api-key` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **resolved**

## Summary

ApiPrincipal unions ship ApiKeyPrincipal and ServicePrincipal variants (packages/api/src/Api.ts:27-33), and the spec appendix shows machine-to-machine groups authenticated by an x-api-key scheme — but no code path produces either principal: the api-key plugin is export-{}, and qadi's SubjectResolver documents the gap ('there is no @awthaq/api-key plugin yet (M7, unbuilt)', packages/qadi/src/SubjectResolver.ts:28-30). A headless platform's self-service/admin separation normally includes the machine-client axis; today an API-only consumer has exactly one route in (a human session cookie or a dev-issued bearer), and the SubjectGroup (/subject) has no non-interactive caller.

## Evidence

Source: `packages/api-key/src/index.ts:8`

```
Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

Prioritize the api-key plugin above cosmetic plugins: key hashing can reuse the Verification machinery, resolution slots into the existing Authentication strategy chain, and scopes can extend PrincipalRef — closing the only remaining hole in the principal taxonomy qadi already handles defensively.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `apikey-machine-identity`. Duplicate of `MAPS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:27`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MAPS-003-microservices-auth-propagation-specialist` — closed by its fix (see that issue's Resolved comment).
