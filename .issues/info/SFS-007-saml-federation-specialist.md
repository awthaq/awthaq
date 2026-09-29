---
ID: "SFS-007"
Title: "Spec row lists its gaps but omits canonicalization and signature-wrapping"
Level: info
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/models/10-saml.md:56"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-007 — Spec row lists its gaps but omits canonicalization and signature-wrapping

`INFO` · `docs` · `—` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **ready-for-agent**

## Summary

The what-is-missing list is honest (no contract, no XML-signing port, no metadata format, no E5 answer) but never names the two failure classes that dominate real-world SAML exploitation: canonicalization mismatches and signature-wrapping (smuggled unsigned assertions). Meanwhile the repo already carries a complete ordered validation-chain contract in better-auth/04-oauth-and-federation/05-sso.md:182-253 — size, exactly-one-assertion cardinality, domain gate, structural parse, algorithm allow-list, timestamp window — with rationale tying cardinality directly to signature-wrapping defense.

## Evidence

Source: `spec/models/10-saml.md:56`

```
No design beyond this row exists yet — there is no `SamlApi` contract, no XML-signing port, no metadata format decision,
```

## Recommended fix

Adopt that ordered chain as the normative SAML behaviors file (with BEH-EA ids) before implementation starts; ordering is part of the contract (cheap DoS-relevant checks before expensive cryptographic ones).

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SFS-001` — SAML support is entirely absent; OAuth2/OIDC is the only federation surface](info/SFS-001-saml-federation-specialist.md) `_(saml-federation-specialist, info)_`
- [`SFS-003` — No XML-signature port exists despite the spec sketch depending on one](medium/SFS-003-saml-federation-specialist.md) `_(saml-federation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `enterprise-federation-saml-scim`. Evidence at HEAD ec065a7: `spec/models/10-saml.md:56`. Fix: Adopt the ordered SAML validation chain as normative behaviors before implementation (cheap checks before crypto), naming canonicalization and signature wrapping explicitly. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
