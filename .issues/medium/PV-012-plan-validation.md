---
ID: "PV-012"
Title: "KeyRing.rotateNow keeps a compromised key valid for the full 30-day grace period (no revoke-now path)"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/KeyRing.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-012 — KeyRing.rotateNow keeps a compromised key valid for the full 30-day grace period (no revoke-now path)

`MEDIUM` · `security` · `jwt` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

KeyRing.rotateNow keeps a compromised key valid for the full 30-day grace period (no revoke-now path). Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N12).

## Evidence

Source: `packages/jwt/src/KeyRing.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: KRS-008 → jwt-key-rotation-integrity (P03).

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** fixed under KRS-008 (P03: KeyRing.revoke and rotateNow({gracePeriod: zero})); see that issue's Resolved comment for files, tests and gates.
