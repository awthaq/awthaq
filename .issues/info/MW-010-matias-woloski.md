---
ID: "MW-010"
Title: "OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost"
Level: info
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:5"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-010 — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost

`INFO` · `dx` · `oauth` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **resolved**

## Summary

A deliberate tradeoff worth recording from the integration-economics lens: every deployment hand-authors its google/github/apple config (endpoints, scopes, quirks.skipPkce, mapProfile). The upside — no stale vendor presets roting in the library — is real, and mapProfile is a clean identity-glue seam; the downside is that the 80% case (Google, GitHub, Apple) costs every customer a research session and a chance to mis-configure PKCE quirks or scopes. Competing runtimes ship presets as thin data precisely because integration cost is the adoption funnel.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:5`

```
Two factories only — `oidc`/`oauth2` — not per-vendor presets
// (`google()`/`github()`/`apple()`): nothing in BEH-EA-121 through 128
// requires a shipped Google/GitHub/Apple integration, only the mechanism
```

## Recommended fix

Keep the factories canonical, but add a separately-versioned, data-only presets module (issuer/endpoints/scopes/quirks per vendor) so the common case is one import; wrong presets then fail loudly against discovery exact-match rather than silently.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-presets`. Duplicate of `IC-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:5`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
