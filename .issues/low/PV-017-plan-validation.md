---
ID: "PV-017"
Title: "Type-level import cycle AuditLog<->AuthEvents undetected by pnpm circular; nothing ever retains or erases audit_log rows"
Level: low
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/AuditLog.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-017 — Type-level import cycle AuditLog<->AuthEvents undetected by pnpm circular; nothing ever retains or erases audit_log rows

`LOW` · `architecture` · `core` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

Type-level import cycle AuditLog<->AuthEvents undetected by pnpm circular; nothing ever retains or erases audit_log rows. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N17).

## Evidence

Source: `packages/core/src/AuditLog.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: tooling-typecheck-lint (P20), data-retention-sweep (P11).

## Comments

_Triage notes and discussion append here._
