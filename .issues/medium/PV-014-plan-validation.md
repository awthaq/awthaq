---
ID: "PV-014"
Title: "Remaining `as` casts on untrusted input in library source (isFlowPayload, OAuthTokenAccess, Jwt.ts:90) although GC-001 is marked resolved"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:144"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-014 — Remaining `as` casts on untrusted input in library source (isFlowPayload, OAuthTokenAccess, Jwt.ts:90) although GC-001 is marked resolved

`MEDIUM` · `correctness` · `oauth` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

Remaining `as` casts on untrusted input in library source (isFlowPayload, OAuthTokenAccess, Jwt.ts:90) although GC-001 is marked resolved. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N14).

## Evidence

Source: `packages/oauth/src/OAuth.ts:144` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: oauth-provider-response-decoding (P02), AOMS-005 (P03).

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** fixed under ESS-002/ESS-003-effect-schema-specialist (P02: no `as` remains in packages/oauth); see that issue's Resolved comment for files, tests and gates.
