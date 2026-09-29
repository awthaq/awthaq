---
ID: "PV-015"
Title: "applyRotatedSession is not exported from @awthaq/next though the README imports it; makeVerifier is not exported from @awthaq/jwt"
Level: low
Category: "api"
Status: resolved
Package: "next"
Source: "packages/next/src"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-015 — applyRotatedSession is not exported from @awthaq/next though the README imports it; makeVerifier is not exported from @awthaq/jwt

`LOW` · `api` · `next` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

applyRotatedSession is not exported from @awthaq/next though the README imports it; makeVerifier is not exported from @awthaq/jwt. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N15).

## Evidence

Source: `packages/next/src` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: RRS-002 → next-getsession-hardening (P13), P03.

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** fixed under RRS-002 (P13: applyRotatedSession exported) / P03 (makeVerifier exported via @awthaq/jwt/verify); see that issue's Resolved comment for files, tests and gates.
