---
ID: "FAMS-005"
Title: "JWT plugin cannot interop with Firebase tokens in either direction"
Level: medium
Category: "api"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/JwtConfig.ts:23"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-005 — JWT plugin cannot interop with Firebase tokens in either direction

`MEDIUM` · `api` · `jwt` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

Firebase custom tokens and ID tokens are RS256; effect-auth's Jwt supports only EdDSA and ES256, pins verification to its own config.issuer/audience (packages/jwt/src/Jwt.ts:263-265), and its mint endpoint requires an already-authenticated caller (packages/jwt/src/JwtApi.ts:45-49, .middleware(Api.Authentication)). So a migration cannot dual-run: the app cannot verify Firebase-issued tokens while Firebase is still live, and a trusted backend cannot mint an effect-auth assertion for an unauthenticated client to exchange for a session — Firebase's signInWithCustomToken direction has no inbound equivalent at all. signJWT(payload) does provide generic claim-signing (packages/jwt/src/Jwt.ts:250-251), but only for already-trusted server-side callers.

## Evidence

Source: `packages/jwt/src/JwtConfig.ts:23`

```
export type Algorithm = "EdDSA" | "ES256";
```

## Recommended fix

For dual-running, either extend Algorithm with RS256 plus per-issuer verification config (the KeyRing remote-key mechanism already exists for trust anchors), or keep single-issuer and verify Firebase tokens out-of-band server-side before issuing an effect-auth session directly. Document that the mint endpoint is a self-decoration endpoint, not a token-exchange (RFC 8693-style) bootstrap.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`VB-005` — Single shared audience and no token-type separation across all minted JWTs](medium/VB-005-vittorio-bertocci.md) `_(vittorio-bertocci, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jose-algorithm-coverage`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtConfig.ts:23`. Fix: With BAM-010's RS256 support, document and test a Firebase dual-run recipe using `makeVerifier`; state that `/jwt/token` is not an RFC 8693 exchange. Whether to ship an inbound exchange endpoint is open (see decision). (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan; user may revisit. Lite verifier verifies Firebase RS256 ID tokens (makeVerifier with algorithms [RS256], securetoken JWKS, iss https://securetoken.google.com/<projectId>, aud <projectId>); packages/jwt/README.md documents the dual-run recipe and states GET /jwt/token is a self-decoration mint, not an RFC 8693 exchange; model 08 lists inbound exchange as not built. Test: packages/jwt/test/verifyForeignIssuer.test.ts 'an RS256 token with Firebase-shaped iss/aud verifies via makeVerifier against a fake JWKS' plus the allowlist refusal.
