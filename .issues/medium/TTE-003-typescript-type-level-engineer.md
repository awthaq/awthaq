---
ID: "TTE-003"
Title: "OIDC discovery document asserted to DiscoveryDocument, only issuer checked"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:142"
Auditor: "typescript-type-level-engineer"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TTE-003 — OIDC discovery document asserted to DiscoveryDocument, only issuer checked

`MEDIUM` · `correctness` · `oauth` · reported by **TypeScript Type-Level Engineer** (`typescript-type-level-engineer`)

Status: **resolved**

## Summary

The provider metadata fetch asserts the whole document and then checks exactly one field (`document.issuer !== configuredIssuer.value`, next lines). Fields like `authorization_endpoint`/`token_endpoint` are typed as present purely by declaration, so a misconfigured `issuer` URL serving arbitrary JSON produces typed-but-garbage endpoints. Because this resolves once at boot and `orDie`s on failure, boot time is the perfect place to validate the full shape — the current code already pays the crash-on-bad-config cost without getting the safety.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:142`

```
Effect.flatMap((response) => response.json),
Effect.map((body) => body as DiscoveryDocument),
Effect.orDie,
```

## Recommended fix

Schema-validate the discovery document at resolve time (issuer as literal-validated string plus the endpoint fields actually read), so the boot-time `orDie` fails on shape errors too and the cast becomes a decode.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Type-Level Rigor
- Full dossier: [`typescript-type-level-engineer`](../../.reports/typescript-type-level-engineer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-boot-validation`. Duplicate of `ESS-002-effect-schema-specialist` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:142`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-002-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
