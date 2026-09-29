---
ID: "PV-009"
Title: "removeMember/leave leave team memberships behind (qadi still answers team-member) and leave() runs no remove-member hooks"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "organization"
Source: "packages/organization/src/Organization.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-009 — removeMember/leave leave team memberships behind (qadi still answers team-member) and leave() runs no remove-member hooks

`MEDIUM` · `correctness` · `organization` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

removeMember/leave leave team memberships behind (qadi still answers team-member) and leave() runs no remove-member hooks. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N09).

## Evidence

Source: `packages/organization/src/Organization.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: CWM-003 / PCS-002 → org-active-context-lifecycle (P04).

## Comments

_Triage notes and discussion append here._
