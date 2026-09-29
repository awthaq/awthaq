---
ID: "AH-003"
Title: "Discovery document asserted without validation at provider boot"
Level: low
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:142"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-003 — Discovery document asserted without validation at provider boot

`LOW` · `correctness` · `oauth` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

resolve() asserts the discovery response to DiscoveryDocument and dies on any failure. The die-at-boot semantics are deliberate and documented (deployment defect, never per-request), which contains the blast window to plugin initialization, but the assertion still means a valid-JSON non-object document produces undefined endpoints and a less diagnostic boot error than a schema decode would, and the DiscoveryDocument type is unverified at the trust boundary.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:142`

```
Effect.map((body) => body as DiscoveryDocument),
Effect.orDie,
```

## Recommended fix

Use a Schema decode for DiscoveryDocument whose failure maps to the same boot die with the parse detail in the message; boot-time code can afford full validation since it runs once.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-boot-validation`. Duplicate of `ESS-002-effect-schema-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:142`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-002-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
