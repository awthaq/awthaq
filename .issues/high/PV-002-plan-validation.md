---
ID: "PV-002"
Title: "ReactAuthClient never provides the CSRF client middleware — every React mutation gets 403"
Level: high
Category: "correctness"
Status: resolved
Package: "react"
Source: "packages/react/src"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-002 — ReactAuthClient never provides the CSRF client middleware — every React mutation gets 403

`HIGH` · `correctness` · `react` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

ReactAuthClient never provides the CSRF client middleware — every React mutation gets 403. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N02).

## Evidence

Source: `packages/react/src` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: react-client-atoms-factory (P13), interim fix in its step 1.

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** fixed under BE-004 (P13: React mutations send x-csrf-token); see that issue's Resolved comment for files, tests and gates.
