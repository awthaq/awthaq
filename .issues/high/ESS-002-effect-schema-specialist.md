---
ID: "ESS-002"
Title: "OIDC discovery document cast, not decoded, at plugin boot"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuthProvider.ts:142"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-002 — OIDC discovery document cast, not decoded, at plugin boot

`HIGH` · `correctness` · `oauth` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **ready-for-agent**

## Summary

The discovery document is fetched and cast with `body as DiscoveryDocument`; its fields are then consumed by `??=` fallbacks (lines 153-156) and the issuer pin check (line 145) against unvalidated values. A provider returning token_endpoint as a non-string (or an object) sails past the undefined guard and flows into token-endpoint URL construction; the cast also hides a malformed-JSON case inside the boot-time orDie. This is boot-time input, but it is still untrusted wire data decoded by assertion.

## Evidence

Source: `packages/oauth/src/OAuthProvider.ts:142`

```
Effect.map((body) => body as DiscoveryDocument),
```

## Recommended fix

Define DiscoveryDocumentSchema (Schema.Struct with optional string endpoint fields) and decodeUnknown the response body; fail boot with the existing die-on-mismatch semantics but with a decode-error message naming the offending field.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-007` — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE](medium/AP-007-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-003` — Discovery document asserted without validation at provider boot](low/AH-003-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`BO-009` — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing](low/BO-009-balazs-orban.md) `_(balazs-orban, low)_`
- [`IC-003` — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile](medium/IC-003-iain-collins.md) `_(iain-collins, medium)_`
- [`JR-009` — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400](low/JR-009-justin-richer.md) `_(justin-richer, low)_`
- [`MW-010` — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost](info/MW-010-matias-woloski.md) `_(matias-woloski, info)_`
- [`NAM-003` — Zero vendor provider presets — every Auth.js provider must be hand-translated](medium/NAM-003-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`NAM-009` — User.image / OAuth picture dropped: avatar data has no destination](low/NAM-009-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`
- … 2 more findings touch `packages/oauth/src/OAuthProvider.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuthProvider.ts:142` still reads `Effect.map((body) => body as DiscoveryDocument),` followed by `Effect.orDie` (line 143), with `??=` fallback assignment onto unvalidated fields at lines 151-154 and an issuer-pin comparison at line 144 that trusts the cast. Same mechanical fix as ESS-001/GC-001 (a `DiscoveryDocumentSchema` decode). Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-provider-boot-validation`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuthProvider.ts:140`. Fix: Decode the discovery document with a Schema at boot; a shape error dies with a message naming provider and field. (effort S). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`.
