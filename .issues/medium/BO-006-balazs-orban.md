---
ID: "BO-006"
Title: "No stateless edge/middleware verify: presence check is the only proxy-safe primitive, jwt plugin sits unwired"
Level: medium
Category: "architecture"
Status: ready-for-human
Package: "next"
Source: "packages/next/src/HasSessionCookie.ts:32"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-006 — No stateless edge/middleware verify: presence check is the only proxy-safe primitive, jwt plugin sits unwired

`MEDIUM` · `architecture` · `next` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **ready-for-human**

## Summary

The edge story is honest but ends at presence: hasSessionCookie passes for any forged cookie by design, and the only real boundary (getSession) requires Sessions + Users + PrincipalResolver plus a ManagedRuntime — i.e. a database, unusable in middleware/edge by construction. Auth.js ships getToken for exactly this gap. The raw material exists one package away: packages/jwt already implements asymmetric EdDSA/ES256 signing, JWKS exposure, and a JWKS-caching verifier (verify.ts:76 makeVerifier, WebCrypto-based and edge-viable) — but nothing connects it to the adapter surface or to proxy.ts, so the session cookie can never be verified statelessly today.

## Evidence

Source: `packages/next/src/HasSessionCookie.ts:32`

```
export const hasSessionCookie = (request: { readonly headers: HeadersLike }): boolean =>
  hasCookie(request.headers.get("cookie"), Api.SessionCookie.key);
```

## Recommended fix

Expose a getToken-style stateless helper over packages/jwt's makeVerifier, documented as the proxy.ts-safe upgrade over hasSessionCookie, and specify whether minted JWTs can ever back the session cookie or remain a separate token surface.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`NAM-012` — Next.js middleware parity is deliberately weaker — hasSessionCookie verifies nothing](low/NAM-012-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-edge-stateless-tier`. Evidence at HEAD ec065a7: `packages/next/src/HasSessionCookie.ts:32`. Fix: (Pending decision D1) Add an optional stateless edge tier: an opt-in short-lived JWT session-mirror cookie minted by @awthaq/jwt, and an `@awthaq/next/edge` helper that verifies it with the lite verifier — documented as a better redirect signal, never the authorization boundary (BEH-EA-188 unchanged). (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-human.
