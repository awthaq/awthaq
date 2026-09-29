---
ID: "SFS-008"
Title: "Deferral is explicit, justified, and consistent across roadmap artifacts"
Level: info
Category: "compliance"
Status: resolved
Package: "—"
Source: "spec/roadmap.md:125"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-008 — Deferral is explicit, justified, and consistent across roadmap artifacts

`INFO` · `compliance` · `—` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **resolved**

## Summary

archive/PRD.md §17 lists Saml as a Phase-3 official plugin, the adoption matrix (00-adoption-matrix.md:124) carries the Planned-Phase3/P3/E2+E5 row, research/03-auth-landscape.md:212 documents the enterprise demand evidence (WorkOS per-connection pricing; Wave-3 paywall pattern), and the matrix's own honesty note (§5) flags that every Verification cell in these rows reads None. The absence should therefore be scored as deliberate phasing, not negligence — but a Phase-3 promise with zero design depth for the riskiest protocol in the set is still a real obligation.

## Evidence

Source: `spec/roadmap.md:125`

```
SSO, SAML, an OIDC provider, SCIM and device authorization are M(3) roadmap items, not v1 scope
```

## Recommended fix

Keep the phasing, but pull the SamlSigner port design and the SAML validation-chain behaviors file forward as low-cost, implementation-independent spec work so Phase 3 does not start from a blank page.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DTWS-005` — spec/roadmap.md contradicts itself: current-state paragraph says M4+ is implemented, gate-status section says no milestone has begun](medium/DTWS-005-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `enterprise-federation-saml-scim`. Duplicate of `AOMS-009` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/roadmap.md:125`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
