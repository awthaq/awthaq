---
ID: "MAPS-003"
Title: "Service identity is absent - ApiKey/Service principals are dead schema cases"
Level: high
Category: "architecture"
Status: resolved
Package: "api-key"
Source: "packages/api-key/src/index.ts:10"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-003 — Service identity is absent - ApiKey/Service principals are dead schema cases

`HIGH` · `architecture` · `api-key` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

ApiKeyPrincipal and ServicePrincipal exist in the Principal union (packages/api/src/Api.ts:27-33) but no code path ever constructs or resolves them; packages/server/src/Session.ts:29-30 even comments that such a principal reaching a session group is 'a wiring defect'. There is no mTLS story, no client-certificate identity, no service-token issuer, and no API-key credential: a machine caller's only option today is to hold a full user session token. The spec (spec/models/07-api-keys.md) has a complete design - show-once keys, hash-at-rest, scopes as qadi permissions - explicitly marked 'Nothing described here exists yet'.

## Evidence

Source: `packages/api-key/src/index.ts:10`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

## Recommended fix

Ship the api-key plugin per spec/models/07 (prefix + 32 CSPRNG bytes, show-once, hash-at-rest, scopes resolved to a subject via the qadi SubjectResolver slot), and add a ServicePrincipal issuance path (id: 'service:<name>') for non-key-based service-to-service callers.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-006` — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub](low/AR-006-aeneas-rekkas.md) `_(aeneas-rekkas, low)_`
- [`CTA-005` — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone](medium/CTA-005-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`JJS-010` — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation](info/JJS-010-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, info)_`
- [`OCM-002` — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation](high/OCM-002-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, high)_`
- [`SCP-002` — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home](high/SCP-002-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-008` — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders](info/SMS-008-secrets-management-specialist.md) `_(secrets-management-specialist, info)_`
- [`TRBS-009` — API-key credentials are absent: the longest-lived tokens have no revocation path at all](info/TRBS-009-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Machine/service identity & M2M auth (api-key package + client-credentials grant)](../../.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) — `packages/api-key` ships both long-lived API keys (resolving directly to `ApiKeyPrincipal`) and OAuth2 client-credentials M2M clients (resolving to `ServicePrincipal` via a short-lived JWT minted through `packages/jwt`'s signer), giving both dead `Principal` cases a real construction/resolution path. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/api-key/src/index.ts:1-10` matches the evidence verbatim, a literal empty placeholder. `packages/api/src/Api.ts:27-42` confirms `ApiKeyPrincipal`/`ServicePrincipal` exist in the `Principal` union, and `packages/server/src/Session.ts:29-30` labels such a principal reaching a session group "a wiring defect," confirming no resolution path exists. This is a whole-plugin ship decision (key format, scopes, hash-at-rest design per spec/models/07) requiring product/architecture judgment, not a mechanical fix. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `apikey-machine-identity`. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Fix: Give ServicePrincipal a construction path: client_credentials M2M clients in @awthaq/api-key minting short-lived JWTs via @awthaq/jwt, verified back into ServicePrincipal. (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.

**Resolved (2026-09-29):** ServicePrincipal now has a construction path: client_credentials clients in @awthaq/api-key (registerClient/revokeClient/rotateClientSecret; table apikey_client, SHA-256 hashes, at most two valid secrets), POST /api-key/token (RFC 6749 §4.4; client_secret_post + client_secret_basic; scope = requested ∩ registered, disjoint -> invalid_scope; RFC 6749 §5.1/§5.2 bodies as typed Schema errors; per-IP and per-client_id throttles) minting a JWT through Jwt.signJWT (typ service+jwt, sub service:<clientId>, scope, exp = serviceTokenTtl default 15m, optional serviceTokenAudience); verified back through a bearer-carrier credential resolver (verifyJWT + Schema-decoded claims -> ServicePrincipal with scopes, stateless, no DB hit; distinct typ so it never collides with at+jwt principal tokens). Accepted revocation lag documented (README, model 07, ADR-EA-022). ApiKey dependsOn Jwt. Session.ts die-on-non-User left as is; the user tier never admits Service principals (Api.MachineAuthentication is the machine tier). Tests: packages/api-key/test/ServiceToken.test.ts (11x2 stores) and AuthHttp.test.ts (token endpoint, RFC error shapes, expired token 401, revoked client, rotate-secret, throttle). See OCM-002 for gates.
