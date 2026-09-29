---
ID: "PV-003"
Title: "Rotated session secret is lost when the handler fails with a typed error — silent logout"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Authentication.ts:270"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-003 — Rotated session secret is lost when the handler fails with a typed error — silent logout

`HIGH` · `correctness` · `server` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

Rotated session secret is lost when the handler fails with a typed error — silent logout. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N03).

## Evidence

Source: `packages/server/src/Authentication.ts:270` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: PIL-005 → session-rotation-delivery (P01).

## Comments

_Triage notes and discussion append here._
