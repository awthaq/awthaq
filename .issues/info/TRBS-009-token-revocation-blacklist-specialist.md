---
ID: "TRBS-009"
Title: "API-key credentials are absent: the longest-lived tokens have no revocation path at all"
Level: info
Category: "architecture"
Status: resolved
Package: "api-key"
Source: "packages/api-key/src/index.ts:8"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-009 — API-key credentials are absent: the longest-lived tokens have no revocation path at all

`INFO` · `architecture` · `api-key` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

packages/api-key is a placeholder exporting nothing, confirmed against spec/models/07-api-keys.md ('Nothing described here exists yet', Status Planned-Phase2, P1). That makes the credential class with the longest revocation half-life (the spec's worked example issues 90-day keys for CI/service callers) the one with no revocation mechanism, no store, and no per-use check. The planned shape is nonetheless the right one for this domain: `resolve(presented)` is a per-use hash lookup against a positive-list store — inherently revocable the same way sessions are — plus an explicit `revoke`. Documentation and code agree on the absence, so nothing silently over-promises.

## Evidence

Source: `packages/api-key/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

When implementing M7, keep resolve-per-use (never a cached principal beyond the request, per the Authentication.resolveSession precedent), store only the hash, and include revoke/list from day one — the Verification/Sessions atomic-consume patterns in this repo are the templates to copy.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `apikey-machine-identity`. Duplicate of `OCM-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
