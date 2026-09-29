---
ID: "OCM-002"
Title: "The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation"
Level: high
Category: "security"
Status: ready-for-agent
Package: "api-key"
Source: "packages/api-key/src/index.ts:8"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-002 — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation

`HIGH` · `security` · `api-key` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **ready-for-agent**

## Summary

packages/api-key, the designated home of the M2M credential, exports nothing. Key format, hashing at rest, show-once delivery, expiry, list/revoke, and the resolve-to-principal path from spec/models/07-api-keys.md all exist only as prose. The repo already contains every primitive the build needs (SHA-256-at-rest with constant-time compare in Sessions, 32-byte CSPRNG generation in Verification, Redacted support, the Ports stratum), so the gap is implementation, not capability.

## Evidence

Source: `packages/api-key/src/index.ts:8`

```
Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

Implement M7 per the spec sketch: adopt the recommended {prefix}_{secret} format with 32 CSPRNG bytes, store only SHA-256(key) with constant-time comparison (reuse the Sessions.ts:39 pattern — deliberately not argon2id, which would let the unauthenticated /machine group burn password-grade CPU), return the raw key once as Redacted, support expiresIn at create, and implement immediate revoke plus list.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`MAPS-003` — Service identity is absent - ApiKey/Service principals are dead schema cases](high/MAPS-003-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Machine/service identity & M2M auth (api-key package + client-credentials grant)](../../.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) — key format `{prefix}_{keyId}.{secret}` reusing `Sessions.ts`'s exact SHA-256 + constant-time-compare hash-at-rest pattern, with `create`/`list`/`revoke`/`resolve` per `spec/models/07-api-keys.md`'s sketch, plus a parallel hashed-secret client-registration path for M2M. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/api-key/src/index.ts` is still exactly `export {};` behind a comment reading "Empty placeholder — awthaq is pre-implementation. No exported symbols yet." (line 8 verbatim as quoted); no other source file exists under `packages/api-key/src/`, and `lib/index.d.ts` reflects the same empty export. `package.json` is wired to build/typecheck/test normally. `spec/models/07-api-keys.md` confirms the design is still prose-only with explicitly undecided questions (key format, transport, rotation behavior — see its "What is missing" section), so this is a greenfield feature build needing product/design decisions, not a mechanical implementation task. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `apikey-machine-identity`. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Fix: Implement the long-lived API-key credential kind of @awthaq/api-key exactly as decision 10 specifies, and make it a third Authentication scheme. (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
