---
ID: "SMS-008"
Title: "Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders"
Level: info
Category: "architecture"
Status: resolved
Package: "api-key"
Source: "packages/api-key/src/index.ts:8"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-008 — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders

`INFO` · `architecture` · `api-key` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **resolved**

## Summary

packages/api-key (long-lived API keys and their hashing salts), packages/two-factor (TOTP secrets, recovery codes), packages/magic-link, and packages/cli are all empty placeholder modules, so no API-key salt handling, TOTP secret storage, or CLI secret-bearing config exists to audit; packages/next contains only cookie-reading helpers with no config surface. Positive absence notes from the sweep: zero committed .env* files repo-wide, no vendor credential literal patterns anywhere under packages/, examples/, or features/, and the only shipped example is memory-backed with no key requirement (examples/memory-server/index.ts:7, README.md:9).

## Evidence

Source: `packages/api-key/src/index.ts:8`

```
Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

When api-key and two-factor land, store only digests of key material (mirror Sessions.secretHash and Verification.valueHash), encrypt TOTP seeds via the existing Encryption service, and give the CLI's planned 'seed admin' a Config-based password source rather than an argv flag.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `apikey-machine-identity`. Duplicate of `OCM-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
