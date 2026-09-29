---
ID: "PV-007"
Title: "Hook tap() layers carry no requirement on their hook point — INV-EA-005/BEH-EA-094 compile-time guarantee is not enforced"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/HookPoint.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-007 — Hook tap() layers carry no requirement on their hook point — INV-EA-005/BEH-EA-094 compile-time guarantee is not enforced

`MEDIUM` · `architecture` · `core` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

Hook tap() layers carry no requirement on their hook point — INV-EA-005/BEH-EA-094 compile-time guarantee is not enforced. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N07).

## Evidence

Source: `packages/core/src/HookPoint.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: ELC-001 → hook-registry-per-composition (P10).

## Comments

_Triage notes and discussion append here._
