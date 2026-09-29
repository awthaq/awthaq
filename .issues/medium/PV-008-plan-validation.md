---
ID: "PV-008"
Title: "A dynamic org role named owner or admin overwrites that org's built-in statements"
Level: medium
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-008 — A dynamic org role named owner or admin overwrites that org's built-in statements

`MEDIUM` · `security` · `organization` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

A dynamic org role named owner or admin overwrites that org's built-in statements. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N08).

## Evidence

Source: `packages/organization/src/Organization.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: RZS-005 → org-qadi-relationships (P04).

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** fixed under RZS-005 / OHS-005 (P04: built-in and static role names reserved against dynamic roles); see that issue's Resolved comment for files, tests and gates.
