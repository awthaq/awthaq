---
ID: "JR-009"
Title: "oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400"
Level: low
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:179"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-009 — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400

`LOW` · `dx` · `oauth` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

scopes is plain required config passed through verbatim; the oidc() factory (lines 72-76) enforces nothing about it. An OIDC provider configured without 'openid' (e.g. scopes: ["email", "profile"]) never receives an id_token, so at callback time the kind==="oidc" branch fails with the opaque OAuthCallbackFailed (OAuth.ts:586-591) — a boot-preventable misconfiguration that instead manifests as an undiagnosable runtime login failure. The plugin already validates the sibling misconfiguration at boot (missing issuer dies in resolve(), lines 127-131), so the pattern exists.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:179`

```
clientId,
      clientSecret,
      scopes: config.scopes,
```

## Recommended fix

In resolve() (or the oidc factory), die at boot when kind === "oidc" and config.scopes omits "openid", mirroring the existing issuer check.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-provider-boot-validation`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:127`. Fix: Die at boot when an `oidc` provider's scopes omit `openid`. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OAuthProvider.resolve dies at boot when an oidc provider's scopes omit openid; BEH-EA-127 amended. Test 'JR-009: an oidc provider whose scopes omit openid dies at boot' red first. Gates as ESS-002.
