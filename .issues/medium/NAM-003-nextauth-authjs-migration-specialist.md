---
ID: "NAM-003"
Title: "Zero vendor provider presets — every Auth.js provider must be hand-translated"
Level: medium
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:5"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-003 — Zero vendor provider presets — every Auth.js provider must be hand-translated

`MEDIUM` · `dx` · `oauth` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

Auth.js ships ~50 first-party presets that encode each provider's authorization/token/userinfo endpoints, scopes, profile mapping, and check preferences. effect-auth deliberately ships only the mechanism (documented at OAuthProvider.ts:4-11), so a migration must reconstruct google/github/apple/etc. as raw oidc/oauth2 configs — issuer URLs, discovery URLs, scope sets, and mapProfile claim extraction — with no reference table and no way to inherit Auth.js's accumulated per-provider quirks (the `quirks.skipPkce` table is the only per-provider divergence modeled). This is hours of error-prone transcription per provider and a parity risk exactly where Auth.js users never had to think.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:5`

```
spec/models/02-oauth-oidc.md's `OAuthProvider.oidc({...})` sketch, made runnable. Two factories only — `oidc`/`oauth2` — not per-vendor presets
(`google()`/`github()`/`apple()`):
```

## Recommended fix

Ship presets as data over the two factories (the codebase's own stated direction: 'model per-provider divergence as data presets over one core'), starting with the Auth.js top-10 providers, plus an Auth.js-provider-id → preset mapping table in the migration docs.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-presets`. Duplicate of `IC-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:5`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
