---
ID: "PV-001"
Title: "Sessions.verify runs the reuse branch before proving the secret — id-only forced logout"
Level: high
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:439"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-001 — Sessions.verify runs the reuse branch before proving the secret — id-only forced logout

`HIGH` · `security` · `core` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

Sessions.verify runs the reuse branch before proving the secret — id-only forced logout. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N01).

## Evidence

Source: `packages/core/src/Sessions.ts:439` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: PIL-007.

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** Fixed in 3388854 (PIL-007): the secret is now proven before any row-state branch.
