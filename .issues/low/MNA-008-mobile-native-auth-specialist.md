---
ID: "MNA-008"
Title: "__Host-csrf cookie set without Secure - same prefix violation class, currently latent"
Level: low
Category: "security"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Csrf.ts:155"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-008 — __Host-csrf cookie set without Secure - same prefix violation class, currently latent

`LOW` · `security` · `server` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **ready-for-agent**

## Summary

The double-submit cookie is named __Host-csrf (Api.CSRF_COOKIE_NAME, packages/api/src/Api.ts:106) but its attribute set (httpOnly false, sameSite strict, path /) omits secure - browsers reject a __Host- cookie lacking the Secure attribute, so the double-submit half of the CSRF design would never land. Latent today: no HttpApiGroup in the repo declares .middleware(Api.CsrfProtection) yet (confirmed by @awthaq/client's own header comment, AuthClient.ts:28-31), but the moment CSRF is wired this breaks in real browsers and, per the docs' native story, for every bearer client that has no cookie jar to echo from.

## Evidence

Source: `packages/server/src/Csrf.ts:155`

```
          yield* HttpApiBuilder.securitySetCookie(Api.CsrfCookie, fresh, {
            httpOnly: false,
            sameSite: "strict",
```

## Recommended fix

Add secure: true to the CSRF cookie attributes now, before any group wires CsrfProtection.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-005` — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins](low/ACS-005-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`ACS-007` — No minimum length enforced on HMAC signing secrets](low/ACS-007-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`CDS-005` — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs](medium/CDS-005-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`CDS-006` — CSRF token is not bound to the session and never expires](low/CDS-006-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`SMS-004` — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer](medium/SMS-004-secrets-management-specialist.md) `_(secrets-management-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `csrf-hardening`. Evidence at HEAD ec065a7: `packages/server/src/Csrf.ts:153`. Fix: The Secure-attribute claim is invalid, but the consequence it predicts for bearer clients is live: implement decision 24 §2's bearer exemption in CsrfProtectionLive. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
