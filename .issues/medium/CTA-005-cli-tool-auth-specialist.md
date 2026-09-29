---
ID: "CTA-005"
Title: "Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone"
Level: medium
Category: "dx"
Status: resolved
Package: "api-key"
Source: "packages/api-key/src/index.ts:10"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-005 — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone

`MEDIUM` · `dx` · `api-key` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **resolved**

## Summary

The scripted/service-token path this persona requires for CI usage of any authenticated command lives in @awthaq/api-key, which is an export-{} placeholder; spec/roadmap.md:97 shows M7 (its milestone) 'Not yet active'. Server-side, the bearer scheme does exist (packages/api/src/Api.ts:103) with a cookie-then-bearer chain in packages/server/src/Authentication.ts, but nothing mints a long-lived credential a CI process could hold, and no environment-variable contract (AWTHAQ_API_KEY or similar) is specified anywhere. Until M7, any future CLI command that talks to a live server has no non-interactive credential story at all.

## Evidence

Source: `packages/api-key/src/index.ts:10`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

When M7's ApiKey lands, pair it with a documented env-var contract for the CLI (service token plus base URL variables), so pipelines never touch the interactive flow; until then, note the dependency explicitly in 26-cli.md so no login design assumes CI coverage it does not have.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-session-commands`. Duplicate of `CTA-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
