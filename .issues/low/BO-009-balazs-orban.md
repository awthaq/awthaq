---
ID: "BO-009"
Title: "OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing"
Level: low
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:60"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-009 — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing

`LOW` · `dx` · `oauth` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **resolved**

## Summary

Providers are configured as raw mechanism data: two factories (oidc/oauth2), no google()/github()/apple() presets (a deliberate, documented choice), a hand-written mapProfile per provider, and issuer/clientId/clientSecret typed as Effect Config.Config<T> descriptions rather than plain values resolved from env at the config boundary. The mechanism-first core is defensible, but every deployment pays the full boilerplate Auth.js presets exist to avoid, and the Config.Config<T> surface means composing providers requires understanding Effect's config DSL — a framework-adapter-level typing burden, not just an OAuth detail.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:60`

```
  readonly clientId: Config.Config<string>;
  /** BEH-EA-126: read via `Config.Redacted` — absent only for a fully public client. */
  readonly clientSecret?: Config.Config<Redacted.Redacted<string>>;
```

## Recommended fix

Keep the mechanism core but add a thin presets layer (clientSecret from env by convention, issuer as string), and accept plain strings with an optional Config escape hatch so the common declaration is five lines.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-provider-presets`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:55`. Fix: Accept `string | Config.Config<string>` for non-secret provider fields (issuer, discoveryUrl, clientId); keep clientSecret Config.Redacted-only per BEH-EA-126; presets tracked by IC-003. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OAuthProviderConfig.issuer/discoveryUrl/clientId accept string | Config<string> (OAuthProvider.liftConfig via Config.succeed, no casts; also used by OAuth.accountAnchorFor); clientSecret stays Config<Redacted> only per BEH-EA-126. Tests: plain-string oidc provider resolves and authorizes with the literal client_id; a plain-string clientSecret is a @ts-expect-error type failure. Gates as IC-003.
