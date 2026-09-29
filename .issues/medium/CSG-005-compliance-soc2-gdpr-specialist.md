---
ID: "CSG-005"
Title: "No data-subject access or portability export path in the HTTP surface"
Level: medium
Category: "compliance"
Status: ready-for-human
Package: "api"
Source: "packages/api/src/Account.ts:34"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-005 — No data-subject access or portability export path in the HTTP surface

`MEDIUM` · `compliance` · `api` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **ready-for-human**

## Summary

The account group exposes exactly updateProfile and deleteUser; the session group offers current/list/revoke variants and the subject group a single current read. There is no endpoint that exports a subject's personal data, so GDPR Art. 15 (access) and Art. 20 (portability) have no supported path - an operator would have to hand-run queries across users, accounts, sessions and organization tables to answer one request.

## Evidence

Source: `packages/api/src/Account.ts:34`

```
  .add(HttpApiEndpoint.delete("deleteUser", "/user"))
```

## Recommended fix

Add a GET /user/export endpoint behind the existing Authentication middleware that aggregates the user record, linked accounts, session list, and organization memberships into a single downloadable document (JSON or CSV).

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `gdpr-erasure-export`. Evidence at HEAD ec065a7: `packages/api/src/Account.ts:27`. Fix: Add a GDPR Art. 15/20 self-service export: GET /auth/user/export under Authentication, aggregating core data plus plugin-contributed sections. (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-human.
