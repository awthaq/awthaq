---
ID: "PV-013"
Title: "README quickstart no longer type-checks (Mailer lacks sent, no AuditLog/CsrfProtection layers); package rosters drifted (21 of 23 packages listed)"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "README.md"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-013 — README quickstart no longer type-checks (Mailer lacks sent, no AuditLog/CsrfProtection layers); package rosters drifted (21 of 23 packages listed)

`MEDIUM` · `docs` · `—` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

README quickstart no longer type-checks (Mailer lacks sent, no AuditLog/CsrfProtection layers); package rosters drifted (21 of 23 packages listed). Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N13).

## Evidence

Source: `README.md` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: readme-docs-accuracy / workspace-roster-sync (P19/P20).

## Comments

_Triage notes and discussion append here._
