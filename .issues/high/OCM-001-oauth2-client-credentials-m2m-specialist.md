---
ID: "OCM-001"
Title: "No client-credentials grant or token-issuing authorization server exists for machine callers"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:199"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-001 — No client-credentials grant or token-issuing authorization server exists for machine callers

`HIGH` · `architecture` · `oauth` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **ready-for-agent**

## Summary

The only OAuth2 grant in the monorepo is the outbound authorization_code exchange that packages/oauth performs as a client against external providers (Google/GitHub). There is no token endpoint, no client registration, and no client secret model, so RFC 6749 section 4.4 (client credentials) is entirely absent: a service caller has no standards-based way to obtain a short-lived scoped token. Service-to-service callers today have no authentication path at all.

## Evidence

Source: `packages/oauth/src/OAuth.ts:199`

```
grant_type: "authorization_code",
```

## Recommended fix

Keep packages/oauth a pure client. For standards-based M2M, implement client_credentials in the already-planned Phase-3 OidcProvider plugin (confidential clients, hashed secrets, scope negotiation), or expose the existing JWT signer behind an authenticated mint path for ApiKey principals — either way with scopes negotiated at issuance, never inherited from a user session.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Machine/service identity & M2M auth (api-key package + client-credentials grant)](../../.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) — client_credentials ships now as `packages/api-key`'s own `POST auth/apiKey/token` endpoint (minting short-lived JWTs via `packages/jwt`'s signer) rather than waiting on the Phase-3 `OidcProvider`; `packages/oauth` stays a pure outbound client and never grows a token-issuing side. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `grant_type: "authorization_code"` is the only grant-type literal in `packages/oauth/src/OAuth.ts:199`, and a repo-wide grep for `client_credentials`/`grant_type` across all `*.ts` files (excluding tests) finds no other match anywhere in the codebase; there is no token endpoint, client registration, or client-secret model for M2M callers. This is a real, confirmed gap, but the two remediation paths the issue itself lists (a Phase-3 `OidcProvider` authorization-server plugin, or an authenticated mint path off the JWT signer for `ApiKey` principals) are alternative architectures requiring a product/design decision, not a mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `m2m-client-credentials`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:238`. Fix: Implement ticket 10's M2M half in packages/api-key. Nothing changes in packages/oauth. (effort XL). Full dossier: `.plan/slices/03-oauth-flow.md`.
