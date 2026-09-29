---
ID: "VB-005"
Title: "Single shared audience and no token-type separation across all minted JWTs"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/JwtConfig.ts:44"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-005 — Single shared audience and no token-type separation across all minted JWTs

`MEDIUM` · `architecture` · `jwt` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **ready-for-agent**

## Summary

Every token the plugin mints carries the same iss/aud pair: principal tokens (sub/sid/act) and arbitrary signJWT machine tokens share keys, issuer, audience, and TTL semantics, with no typ header (HeaderSchema only parses alg/kid, JwtCodec.ts:48-51) and no token_use-style claim to distinguish classes. A downstream verifier built with makeVerifier (issuer/audience/algorithm only) therefore accepts every token class interchangeably — a machine token minted with signJWT({ sub: 'user-1', sid: '...' }) would even pass verifyLive's liveness check. Per-resource audience scoping, the standard multi-service containment mechanism, is impossible with one config value. This also falls short of the repo's own spec, which demanded strict alg/typ/iss/aud verification per RFC 8725 (spec/models/08-jwt-bearer.md:80).

## Evidence

Source: `packages/jwt/src/JwtConfig.ts:44`

```
audience: options.audience ?? options.issuer,
```

## Recommended fix

Stamp typ (or token_use) at mint and require it in JwtCodec.verify; allow an audience-per-consumer or audience-array configuration so each downstream service can pin the single aud it accepts.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`FAMS-005` — JWT plugin cannot interop with Firebase tokens in either direction](medium/FAMS-005-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-claims-codec-hardening`. Evidence at HEAD ec065a7: `packages/jwt/src/JwtConfig.ts:44`. Fix: Separate token classes by header `typ` (principal/delegation tokens vs general signJWT tokens) and allow per-call audience on signJWT, per wayfinder ticket 33's `signJWT({ audience })` decision. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.
