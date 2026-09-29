---
ID: "PV-005"
Title: "GET /session/current returns 500 past 200 sessions (oldest-first capped list, expired rows included)"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-005 — GET /session/current returns 500 past 200 sessions (oldest-first capped list, expired rows included)

`MEDIUM` · `correctness` · `core` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

GET /session/current returns 500 past 200 sessions (oldest-first capped list, expired rows included). Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N05).

## Evidence

Source: `packages/core/src/Sessions.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: ESS-005-effect-stream-specialist / TIR-003 → session-list-correctness (P01).

## Comments

_Triage notes and discussion append here._
