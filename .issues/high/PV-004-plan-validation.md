---
ID: "PV-004"
Title: "Decision 24 §2's CSRF exemption for bearer requests was never implemented — bearer/native clients get 403 on sign-out/revoke/delete"
Level: high
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Csrf.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-004 — Decision 24 §2's CSRF exemption for bearer requests was never implemented — bearer/native clients get 403 on sign-out/revoke/delete

`HIGH` · `correctness` · `server` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

Decision 24 §2's CSRF exemption for bearer requests was never implemented — bearer/native clients get 403 on sign-out/revoke/delete. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N04).

## Evidence

Source: `packages/server/src/Csrf.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: MNA-008 → csrf-hardening (P01).

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** fixed under MNA-008 (P01: bearer requests exempt from CSRF); see that issue's Resolved comment for files, tests and gates.
