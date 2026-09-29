---
ID: "PV-016"
Title: "Session cookie is SameSite=Strict but set on a redirect chain the provider started cross-site — first landing request after OAuth sign-in may look signed out"
Level: low
Category: "security"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-016 — Session cookie is SameSite=Strict but set on a redirect chain the provider started cross-site — first landing request after OAuth sign-in may look signed out

`LOW` · `security` · `oauth` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **ready-for-agent**

## Summary

Session cookie is SameSite=Strict but set on a redirect chain the provider started cross-site — first landing request after OAuth sign-in may look signed out. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N16).

## Evidence

Source: `packages/oauth/src/OAuth.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: P02 / IC-007 cookie decision.

## Comments

_Triage notes and discussion append here._
