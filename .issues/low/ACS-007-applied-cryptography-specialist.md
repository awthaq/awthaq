---
ID: "ACS-007"
Title: "No minimum length enforced on HMAC signing secrets"
Level: low
Category: "security"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Csrf.ts:26"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-007 — No minimum length enforced on HMAC signing secrets

`LOW` · `security` · `server` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **ready-for-agent**

## Summary

CsrfConfig.secret and ChallengeCookieConfig.secret accept any string as an HMAC-SHA256 key with no entropy or length floor, while KeyProvider.layerEnv dies loudly unless AWTHAQ_ENCRYPTION_KEY decodes to exactly 32 bytes (KeyProvider.ts:89-95). An operator who passes a short human-memorable secret to the CSRF or passkey-cookie layers gets textbook HMAC of a brute-forceable key, silently undermining the double-submit cookie signature and the stateless passkey challenge. The inconsistent posture between ports is itself the hazard: the strict layer proves the codebase knows how to fail loudly.

## Evidence

Source: `packages/server/src/Csrf.ts:26`

```
  readonly secret: Redacted.Redacted<string>;
```

## Recommended fix

Enforce a documented minimum (32 bytes) at layer construction for both secret-bearing configs, mirroring KeyProvider's die-on-misconfiguration behavior.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-005` — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins](low/ACS-005-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`CDS-005` — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs](medium/CDS-005-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`CDS-006` — CSRF token is not bound to the session and never expires](low/CDS-006-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`MNA-008` — __Host-csrf cookie set without Secure - same prefix violation class, currently latent](low/MNA-008-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, low)_`
- [`SMS-004` — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer](medium/SMS-004-secrets-management-specialist.md) `_(secrets-management-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hmac-secret-hygiene`. Evidence at HEAD ec065a7: `packages/server/src/Csrf.ts:24`. Fix: Enforce a 32-byte minimum on HMAC signing secrets at layer construction, dying loudly like KeyProvider.layerEnv. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
