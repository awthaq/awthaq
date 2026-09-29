---
ID: "IC-008"
Title: "Single session strategy: no JWT-session option for edge/serverless render paths"
Level: info
Category: "architecture"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/index.ts:3"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-008 — Single session strategy: no JWT-session option for edge/serverless render paths

`INFO` · `architecture` · `jwt` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

The database-verified strategy is the revocation-correct default and I would not call JWT sessions strictly better — instant revokeAll/revoke semantics (Sessions.ts:190-194) are exactly what stateless session cookies give up. But the offering is binary: the JWT plugin signs downstream-service tokens, not session cookies, so an app that needs cookie-presence-only rendering at the edge (the reason Next's own proxy guidance forbids database checks per request, cited in spec/behaviors/24-nextjs-ssr.md:90) or multi-region reads without a session-store round trip has no supported configuration. Auth.js's strategy: 'jwt' | 'database' per deployment is the established vocabulary here.

## Evidence

Source: `packages/jwt/src/index.ts:3`

```
// Short-lived, self-contained, cryptographically signed JWTs representing
// an already-authenticated caller — EdDSA/ES256, JWKS with grace-period
```

## Recommended fix

At minimum, document the tradeoff and the current answer for edge deployments (bearer tokens via the JWT plugin are the substitute). A short-TTL JWE session-cookie strategy with revocation-list override would be the eventual parity feature.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-stateless-bearer-reentry`. Duplicate of `NAM-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/index.ts:3`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
