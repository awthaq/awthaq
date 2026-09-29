---
ID: "AP-007"
Title: "quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:30"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-007 — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE

`MEDIUM` · `security` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

BEH-EA-121 makes pkce a structural true so it cannot be turned off accidentally, but quirks.skipPkce re-opens the hole at configuration level with no enforcement of its own stated scope ("providers that reject PKCE outright"). resolve() (OAuthProvider.ts:116-183) happily registers a provider with no clientSecret (a public client, per the clientSecret doc comment at line 61) and skipPkce: true — a public authorization-code client with no PKCE, which RFC 9700 2.1.1 and the OAuth 2.1 drafts make mandatory for public clients because authorization-code interception is unmitigated. Nothing at boot distinguishes the legitimate Apple-style quirk from a general escape hatch.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:30`

```
export interface OAuthProviderQuirks {
  readonly skipPkce?: boolean;
}
```

## Recommended fix

In resolve(), die when quirks.skipPkce is set and clientSecret is absent, and log loudly when it is set at all; keep the quirk table as the single documented source of which providers set it.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-boot-validation`. Duplicate of `OAP-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:29`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
