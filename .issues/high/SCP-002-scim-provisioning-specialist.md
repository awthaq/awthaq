---
ID: "SCP-002"
Title: "No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home"
Level: high
Category: "security"
Status: resolved
Package: "api-key"
Source: "packages/api-key/src/index.ts:8"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-002 — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home

`HIGH` · `security` · `api-key` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

RFC 7644 SCIM endpoints are bearer-token authenticated per-connection (spec/models/12-scim.md:38), and spec/models/12-scim.md:57 admits 'no authentication design for the bearer token a directory service would present'. That token is a long-lived static secret guarding user creation and deactivation across an entire enterprise directory — the highest-value credential in the flow. The capability that should mint, hash-store, and rotate it (api-key, M7) contains zero code, and no Bearer plugin package exists, so any near-term SCIM implementation would improvise credential storage — exactly the kind of ad-hoc secret handling this codebase otherwise refuses (cf. Sessions persisting only SHA-256 hashes of secrets).

## Evidence

Source: `packages/api-key/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Implement the api-key/machine-credential primitive before SCIM: hashed-at-rest keys, per-connection issuance, scoped to the SCIM resource paths, with rotation and revocation that composes with Sessions/RateLimiter. SCIM's directory token should be its first consumer, not a bespoke string in a new plugin.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Machine/service identity & M2M auth (api-key package + client-credentials grant)](../../.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) — SCIM's directory bearer token is an ordinary API key (long-lived credential kind, not the client_credentials flow), created via `api-key`'s `create(name, scopes, expiresIn)` and scoped to `scim:*` permissions, giving it the hash-at-rest/rotation/revocation substrate it was missing. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — packages/api-key/src/index.ts:8-10 is exactly the cited empty placeholder (`export {}`), and spec/roadmap.md:97 confirms M7 Phase-2 plugins (including api-key) are "Not yet active". Designing the machine-credential primitive (format, hashing, rotation, scoping) is a genuine architecture decision, not a mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `apikey-machine-identity`. Duplicate of `OCM-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
