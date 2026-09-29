---
ID: "SCP-009"
Title: "Absence is deliberate and well-governed: Planned-Phase3/P4 with an honest least-designed self-assessment"
Level: info
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/models/12-scim.md:57"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-009 — Absence is deliberate and well-governed: Planned-Phase3/P4 with an honest least-designed self-assessment

`INFO` · `docs` · `—` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

The zero-implementation state is not an oversight: the adoption matrix records SCIM as Planned-Phase3, priority P4, enabler E5 (spec/models/00-adoption-matrix.md:126), the roadmap explicitly excludes it from v1 scope (spec/roadmap.md:125), and the model file candidly enumerates what is missing rather than implying coverage. This matches the competitive evidence the repo itself cites (SCIM is universally a paid Phase-3 capability). The report treats the absence as a phasing fact; the findings above are the prerequisite checklist for when Phase 3 opens, not defects in shipped code.

## Evidence

Source: `spec/models/12-scim.md:57`

```
This is the least-designed row in the whole matrix. Beyond the one-line mention in `archive/PRD.md` §17 and the landscape evidence in `research/03-auth-landscape.md`, there is no `ScimApi` contract
```

## Recommended fix

Keep the phasing, but convert the model file's 'What is missing' list into tracked decisions (mapping table, bearer auth, deactivation-vs-delete semantics) so Phase-3 work starts from decided contracts rather than rediscovering them; the reference contract in better-auth/04-oauth-and-federation/06-scim.md is a strong input.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `enterprise-federation-saml-scim`. Duplicate of `CWM-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/models/12-scim.md:57`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
