---
ID: "CSG-005"
Title: "No data-subject access or portability export path in the HTTP surface"
Level: medium
Category: "compliance"
Status: resolved
Package: "api"
Source: "packages/api/src/Account.ts:34"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-005 — No data-subject access or portability export path in the HTTP surface

`MEDIUM` · `compliance` · `api` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

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

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option (b) per plan - a DataExport aggregating registry mirroring the erasure contract; user may revisit. GET /user/export (packages/api/src/Account.ts: exportData + AccountExportDto, RateLimited error) under Authentication + CsrfProtection; packages/server/src/Account.ts handler rate-limits per account (5/hour via RateLimits.enforce, 429 with retryAfterMillis) and sets Content-Disposition: attachment; filename="account-export.json" and Cache-Control: no-store. Core: packages/core/src/DataExport.ts (AccountExport.exportAccount assembling user, accounts sorted stably and WITHOUT credential hashes/tokens, live sessions, the person's own audit activity with ip/userAgent, and one sections[<plugin id>] per contribution) and DataExportRegistry.ts (registry carried by Hooks.HooksLive, so no composition edit; DataExport.contribute layers REQUIRE the registry; frozen at first read). Registries share internal/contributionRegistry.ts with Erasure. A failing contribution fails the whole export (no partial document, no event). New event auth.user.dataExported {userId, requestedBy: self|admin} audits every export (schema, actorOf, exhaustive sample table, 13-events taxonomy). Contributions: organization (memberships, teams, invitations sent/received with NO third-party address; new InvitationRecords.listByInviter, both layers, tenant-scoping allowlisted), passkey (credential metadata; never public key, WebAuthn handle or counter), roles (role names), claims (claims document); each plugin's `contributes` now merges its erasure and export layers. Tests: packages/core/test/AccountExport.test.ts (contributions under their ids in run order, no secrets / no other user's data, audited, admin requestedBy, unknown user, failing contribution, freeze), server AuthHttp.test.ts (200 with attachment headers and no secrets, 401 without auth, 429 on the sixth export), OrganizationExport/PasskeyErasure/Roles/RolesSql/UserClaims contribution tests. Spec: new BEH-EA-225 (06-domain-users-accounts.md), ADR-EA-031 item 5, README 'Exporting an account', docs/plugin-authoring.md 'Personal data: erasure and export'. Compositions running Account.AccountHandlers now also provide DataExport.layer and a RateLimiter (TestAuth already does). Not covered, documented: the raw IP stored on a session row (core does not expose it; the same address appears in activity) and the retained impersonation ledger. Merge note: BEH-EA-225 and the ADR ids may need renumbering against other programs' additions.
