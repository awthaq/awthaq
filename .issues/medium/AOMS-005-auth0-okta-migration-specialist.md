---
ID: "AOMS-005"
Title: "Upstream id_token verification is RS256-only"
Level: medium
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/Jwt.ts:242"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-005 — Upstream id_token verification is RS256-only

`MEDIUM` · `api` · `oauth` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

The header documents this deliberately (RS256-only, ES256/EdDSA 'not implemented'), and it is at least an allowlist rather than an algorithm-confusion hole. But tenants migrating from legacy Auth0 configurations sometimes run HS256 (client-secret-signed) connections, and some Okta/Entra authorization servers are set up with ES256 — none of those can federate. Refusing everything else is safe; the cost is silent: callback failures that look identical to configuration mistakes.

## Evidence

Source: `packages/oauth/src/Jwt.ts:242`

```
    if (decoded.header.alg !== "RS256") {
      return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
    }
```

## Recommended fix

Add ES256/EdDSA verification via the same crypto.subtle path (keys are already JWK), keep the strict per-provider algorithm allowlist, and include the provider's signed alg list (discovery id_token_signing_alg_values_supported) in the boot-time resolve() check so misconfiguration dies at boot, not per request.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-002` — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable](medium/AP-002-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-001` — Unvalidated JWT header cast turns attacker-controlled input into an unhandled defect](high/AH-001-anders-hejlsberg.md) `_(anders-hejlsberg, high)_`
- [`ACS-003` — OIDC key selection falls back to the first RSA key on kid mismatch](low/ACS-003-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`ERAS-007` — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)](info/ERAS-007-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`ESS-004` — oauth/Jwt.ts decodes untrusted JWS segments by cast; null header becomes a defect](medium/ESS-004-effect-schema-specialist.md) `_(effect-schema-specialist, medium)_`
- [`ESS-007` — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule](low/ESS-007-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`JR-002` — Documented JWKS refetch-on-kid-miss is dead code: findKey falls back to the first RSA key, so provider key rotation bricks id_token verification until restart](high/JR-002-justin-richer.md) `_(justin-richer, high)_`
- [`JJS-001` — OAuth findKey kid-miss fallback defeats JWKS refetch: provider key rotation breaks all OIDC logins until restart](high/JJS-001-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, high)_`
- … 4 more findings touch `packages/oauth/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jose-algorithm-coverage`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:313`. Fix: Generalize OAuth id_token verification to RS256/PS256/ES256/ES384/EdDSA under a per-provider allowlist seeded from discovery, checked at boot. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Plan note (2026-09-29):** Not done in P03: packages/oauth is owned by the P02 agent and this is blocked by ESS-002-effect-schema-specialist (discovery decoding). The jwt package now has the reusable pieces: JwtCodec's single AlgorithmSpec table (EdDSA/ES256/ES384/RS256/PS256: import/sign params + kty per alg) and JwtCodec.isAlgorithm; packages/oauth cannot import @awthaq/jwt (it would add a plugin-to-plugin dependency), so the OAuth side should mirror the table in packages/oauth/src/Jwt.ts per the dossier steps, or the table could be lifted into @awthaq/ports if the P02 agent prefers one copy.

**Resolved (2026-09-29):** packages/oauth/src/Jwt.ts: verifyRs256 replaced by verifySignature(alg, jwk, ...) over a five-entry WebCrypto table (RS256, PS256, ES256, ES384, EdDSA; SIGNING_ALGS/isSigningAlg, no HS256/none); JwkSchema is the RSA|EC|OKP union and findKey(jwks, kid, alg) only returns a key of the type/curve the algorithm can use whose advertised alg (if any) matches; header comment rewritten; the residual parts-cast was already gone. OAuthProviderConfig.idTokenSigningAlgs + ResolvedProvider.idTokenSigningAlgs: explicit list, else discovery id_token_signing_alg_values_supported intersected with SIGNING_ALGS, else [RS256]; empty for an oidc provider dies at boot naming the provider. IdToken.verify checks the header alg against the allowlist (never widens) and threads alg through findKey/refreshOnMiss/verifySignature. Tests: Jwt.test.ts real-keypair signature round trips per algorithm + type/curve/alg mismatch (red first: verifySignature missing), OAuth.test.ts ES256 callback succeeds, RS256 token rejected for allowlist [ES256], discovery-advertised default excludes unsupported, boot dies when only unsupported are advertised. Optional HS256-with-client-secret not done (dossier marks it optional). README and BEH-EA-127 text updated.
