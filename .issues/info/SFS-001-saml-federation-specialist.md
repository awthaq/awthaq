---
ID: "SFS-001"
Title: "SAML support is entirely absent; OAuth2/OIDC is the only federation surface"
Level: info
Category: "architecture"
Status: resolved
Package: "—"
Source: "spec/models/10-saml.md:24"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-001 — SAML support is entirely absent; OAuth2/OIDC is the only federation surface

`INFO` · `architecture` · `—` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **resolved**

## Summary

Zero matches for saml/samlp/XML-DSig/canonicalization across packages/ and features/, and no saml or sso package exists in the 21-package tree. The only federation path today is packages/oauth (OAuth2 authorization-code + PKCE, OIDC id_token). Enterprise customers evaluating effect-auth against competitors whose SSO story includes SAML (Okta, ADFS, PingFederate legacy estates) cannot be served; the absence is a documented Phase-3 decision, not an oversight, but it is total.

## Evidence

Source: `spec/models/10-saml.md:24`

```
| Status | Planned-Phase3 |
| Priority | P3 |
```

## Recommended fix

Treat MOD-EA-010 as the entry ticket: when Phase 3 opens, seed packages/saml directly from the 10-saml.md sketch (it uses real, shipped AuthPlugin signatures) rather than inventing a parallel plugin shape.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SFS-003` — No XML-signature port exists despite the spec sketch depending on one](medium/SFS-003-saml-federation-specialist.md) `_(saml-federation-specialist, medium)_`
- [`SFS-007` — Spec row lists its gaps but omits canonicalization and signature-wrapping](info/SFS-007-saml-federation-specialist.md) `_(saml-federation-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `enterprise-federation-saml-scim`. Duplicate of `AOMS-009` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/models/10-saml.md:24`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AOMS-009-auth0-okta-migration-specialist` — closed by its fix (see that issue's Resolved comment).
