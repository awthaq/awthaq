---
ID: "BAM-008"
Title: "OAuth token lifecycle is thinner: no refresh, no idToken/expiry/scope columns"
Level: medium
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:14"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-008 — OAuth token lifecycle is thinner: no refresh, no idToken/expiry/scope columns

`MEDIUM` · `api` · `oauth` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **resolved**

## Summary

The plugin header scopes out token refresh, calling it a real gap for production. The Account model stores only accessToken/refreshToken (packages/sql/src/Models.ts:94-95) — no idToken, no accessTokenExpiresAt, no scope — while better-auth's Account entity carries idToken alongside access/refresh tokens. Post-migration, users whose access tokens expire (Google: ~1 hour) cannot refresh and must re-run consent flows the old system handled silently; provider presets are also absent (documented), so every provider is hand-configured.

## Evidence

Source: `packages/oauth/src/OAuth.ts:14`

```
// own header), no token refresh operation (nothing in BEH-EA-121..128
```

## Recommended fix

Add accessTokenExpiresAt/scope columns and a refresh operation to the OAuth plugin before advertising OAuth-account migration; map better-auth's idToken column during import (drop or store) so no source field is silently lost, per BEH-EA-207's own rule.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `provider-token-storage`. Evidence at HEAD ec065a7: `packages/core/src/Accounts.ts:85`. Fix: Persist the provider's id_token (encrypted at rest, like access/refresh tokens) as part of ProviderTokenSet so better-auth account imports have a destination and a future RP-initiated logout can send id_token_hint. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ProviderTokenSet gains idToken: Option<Redacted<string>> (core Accounts: layerMemory carries it, layerSql maps tokenSetToRow/rowToProviderTokenSet; updateCredentialHash now passes existing.idToken through so its constructor-default null cannot wipe it); sql Models.Account.idToken (Model.Sensitive, constructor default null), AccountsRepositoryLive encrypts/decrypts it with AAD providerId:userId:idToken; new forward-only CoreMigrations migration 18 add_accounts_id_token_column (pg + sqlite). OAuth.toProviderTokenSet stores tokens.idToken; OAuthTokenAccess.refresh keeps the stored id_token when the refresh response has none and replaces it when one is sent. Tests: core Accounts.test.ts (both layers: link persists id_token, updateCredentialHash keeps it, updateProviderTokens replaces), sql Repositories.test.ts (round trip, ciphertext at rest, absent from JSON variant), OAuth.test.ts (oidc sign-up persists the exact returned JWT), OAuthTokenAccess.test.ts (keep/replace on refresh); existing token-set literals gained idToken: Option.none(). Migration number 18 may collide with other programs' migrations (orchestrator: renumber). Not done: packages/migrate-better-auth mapping of better-auth's idToken onto this column (P09/P17 territory, BEH-EA-207) -- the destination now exists. GDPR cascade already deletes account rows; no separate PII store added. Files outside packages/oauth: packages/core/src/Accounts.ts, packages/sql/src/{Models,Repositories,CoreMigrations}.ts and their tests. Gates: tsc -b, tsconfig.test.json, vitest 907 pass, test:bdd 106, spec:verify:strict, oxlint (only pre-existing core HttpApiTypes.test.ts error).
