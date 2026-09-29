---
ID: "CDS-005"
Title: "siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs"
Level: medium
Category: "security"
Status: resolved
Package: "server"
Source: "packages/server/src/Csrf.ts:124"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-005 — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs

`MEDIUM` · `security` · `server` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

The site check accepts Sec-Fetch-Site: same-site (and returns true when neither Sec-Fetch-Site nor Origin is present, Csrf.ts:127-130). This matches spec BEH-EA-073, which requires rejecting only cross-site, and the design intends the signed double-submit check to back it (BEH-EA-075). But the composition's safety rests on that second leg: a compromised sibling subdomain sends same-site requests that pass the site check, and its script cannot read the host-only __Host-csrf cookie, so the double-submit check is exactly what stops it — and today that check never runs because no group attaches the middleware (CDS-001). Until attachment happens, the entire three-layer design collapses to the one layer (SameSite=Strict) that the persona's own rubric calls insufficient.

## Evidence

Source: `packages/server/src/Csrf.ts:124`

```
return secFetchSite.value !== "cross-site";
```

## Recommended fix

Treat CDS-001 as the gating fix for this design; once attached, the same-site acceptance is defensible. Optionally document the subdomain-trust assumption, or treat same-site as needing the Origin fallback when allowedOrigins is configured.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-005` — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins](low/ACS-005-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`ACS-007` — No minimum length enforced on HMAC signing secrets](low/ACS-007-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`CDS-006` — CSRF token is not bound to the session and never expires](low/CDS-006-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`MNA-008` — __Host-csrf cookie set without Secure - same prefix violation class, currently latent](low/MNA-008-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, low)_`
- [`SMS-004` — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer](medium/SMS-004-secrets-management-specialist.md) `_(secrets-management-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `csrf-hardening`. Already fixed by commit 409334e. Evidence at HEAD ec065a7: `packages/server/src/Csrf.ts:122`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
