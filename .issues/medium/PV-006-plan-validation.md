---
ID: "PV-006"
Title: "Failed issue(supersedes) and a crash between the two supersede statements look like token reuse and revoke the whole family"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-006 — Failed issue(supersedes) and a crash between the two supersede statements look like token reuse and revoke the whole family

`MEDIUM` · `correctness` · `core` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

Failed issue(supersedes) and a crash between the two supersede statements look like token reuse and revoke the whole family. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N06).

## Evidence

Source: `packages/core/src/Sessions.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: RRS-004 → session-supersede-atomicity (P01).

## Comments

_Triage notes and discussion append here._
