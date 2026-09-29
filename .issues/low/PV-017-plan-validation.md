---
ID: "PV-017"
Title: "Type-level import cycle AuditLog<->AuthEvents undetected by pnpm circular; nothing ever retains or erases audit_log rows"
Level: low
Category: "architecture"
Status: resolved
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

**Resolved (2026-09-29):** Cycle half: fixed and now guarded. AuditLog<->AuthEvents was already gone (the P10 schema split); scripts/circular.mjs's new type-inclusive pass (which also scans .tsx) found and fixed three other type-level cycles: Users<->Hooks<->{Erasure,DataExport}Registry and OAuthConfig<->OAuthProvider<->ProviderHttp. Retention half (nothing retains or erases audit_log rows) is covered by P11's Retention sweep (Retention.layerScheduled) and AuditLog.pseudonymizeActor / the ErasureRegistry (ADR-EA-029/031).
