---
ID: "ERAS-001"
Title: "No stateless JWT verification tier wired into @awthaq/next despite @awthaq/jwt shipping a purpose-built lite verifier"
Level: medium
Category: "architecture"
Status: resolved
Package: "next"
Source: "packages/next/src/index.ts:9"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-001 — No stateless JWT verification tier wired into @awthaq/next despite @awthaq/jwt shipping a purpose-built lite verifier

`MEDIUM` · `architecture` · `next` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **resolved**

## Summary

The adapter's whole export surface is two tiers: a presence-only check (proxy.ts, passes forged cookies by design) and a database-verified getSession (requires Sessions | Users | PrincipalResolver in the runtime, so it must run where the backing store lives). The middle tier an edge deployment actually wants — a stateless signature check that verifies an opaque-session cookie or short-lived JWT close to the user and defers revocation to origin — does not exist in packages/next, even though @awthaq/jwt/verify.ts is deliberately standalone (no @awthaq/core, no @awthaq/server, WebCrypto-only crypto, JWKS over fetch). Session cookies here are opaque id/secret pairs verified by hashing (packages/core/src/Sessions.ts:230-232), so even the cookie cannot be statelessly validated at the edge without the JWT path.

## Evidence

Source: `packages/next/src/index.ts:9`

```
export { getSession } from "./GetSession.ts";
export type { HeadersLike, Session } from "./GetSession.ts";
export { hasSessionCookie } from "./HasSessionCookie.ts";
```

## Recommended fix

Add an optional stateless tier to @awthaq/next (or a sibling @awthaq/next-edge): wrap @awthaq/jwt's makeVerifier into a getSessionFast(headers) that trusts only the signature/exp/aud claims, document revocation lag explicitly, and keep BEH-EA-188's rule that it too is never the authorization boundary.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-edge-stateless-tier`. Duplicate of `BO-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/src/index.ts:9`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BO-006-balazs-orban` — closed by its fix (see that issue's Resolved comment).
