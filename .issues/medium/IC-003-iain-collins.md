---
ID: "IC-003"
Title: "Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile"
Level: medium
Category: "dx"
Status: ready-for-human
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:5"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-003 — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile

`MEDIUM` · `dx` · `oauth` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **ready-for-human**

## Summary

The provider abstraction is well designed (structural pkce:true that cannot be turned off, Config.Redacted client secrets, discovery with issuer exact-match), but shipping no google()/github()/apple() presets means every application must know each vendor's discovery URL, scopes, and profile-mapping quirks by heart — knowledge Auth.js encodes once in ~80 preset packages so app authors write GitHub({ clientId, clientSecret }). The header comment argues presets are not required by BEH-EA-121..128, but DX parity, not mechanism parity, is the bar providers are compared on.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:5`

```
// runnable. Two factories only — `oidc`/`oauth2` — not per-vendor presets
// (`google()`/`github()`/`apple()`): nothing in BEH-EA-121 through 128
```

## Recommended fix

Ship the common vendors as pure data presets built on the existing oidc/oauth2 factories (id, issuer/discoveryUrl, scopes, mapProfile per vendor) — zero new mechanism, matching the plugin's own test fixtures — and keep the factories as the escape hatch.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-provider-presets`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:5`. Fix: Ship data-only vendor presets built on `oidc`/`oauth2` (zero new mechanism) in an `@awthaq/oauth/presets` subpath, plus an Auth.js provider-id → preset mapping table. (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-human.
