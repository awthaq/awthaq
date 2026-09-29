---
ID: "OAP-005"
Title: "No boot-time guard against quirks.skipPkce on a public client (no clientSecret): bare authorization code exchange"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:180"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-005 — No boot-time guard against quirks.skipPkce on a public client (no clientSecret): bare authorization code exchange

`MEDIUM` · `security` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

resolve() validates at boot that an oidc provider declares an issuer (OAuthProvider.ts:127-131) and that endpoints exist, but nothing validates the PKCE/secret combination. clientSecret is documented as 'absent only for a fully public client' (OAuthProvider.ts:61-62), and skipPkce omits both the code_challenge from the authorize URL (OAuth.ts:500) and the code_verifier from the token exchange (OAuth.ts:204). A provider configured with skipPkce and no clientSecret sends a naked authorization code - neither proof-of-possession nor a confidential credential - which RFC 9700 forbids for every client type and which the codebase's own BEH-EA-121 rationale ('no none escape hatch') intends to prevent. The quirk is documented for providers that reject PKCE outright (Apple), which are confidential clients, so the combination is pure misconfiguration that the type system cannot see.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:180`

```
      scopes: config.scopes,
      skipPkce: config.quirks?.skipPkce ?? false,
```

## Recommended fix

In resolve(), die at boot when config.quirks?.skipPkce is true and clientSecret is undefined, with a message naming the provider id; consider also warning when skipPkce is combined with kind: 'oidc'.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: OAuth2 OIDC flows
- Full dossier: [`oauth2-authorization-code-pkce-specialist`](../../.reports/oauth2-authorization-code-pkce-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`ESS-002` — OIDC discovery document cast, not decoded, at plugin boot](high/ESS-002-effect-schema-specialist.md) `_(effect-schema-specialist, high)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-provider-boot-validation`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:28`. Fix: Gate `quirks.skipPkce` to confidential clients at boot and log whenever it is used. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** OAuthProvider.resolve dies at boot when quirks.skipPkce is set with no clientSecret (RFC 9700 2.1.1) and logs a warning naming the provider for permitted uses; BEH-EA-121 amended. Test 'OAP-005: quirks.skipPkce without a clientSecret dies at boot' red first; existing apple-style skipPkce scenario (with secret) stays green. Gates as ESS-002.
