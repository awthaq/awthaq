---
ID: "SCP-005"
Title: "External-id mapping substrate exists in Accounts but the SCIM id/externalId mapping decision is undocumented"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Accounts.ts:33"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-005 — External-id mapping substrate exists in Accounts but the SCIM id/externalId mapping decision is undocumented

`MEDIUM` · `architecture` · `core` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

AccountRecord's (providerId, subject, issuer) tuple with schema-level uniqueness and findByProviderSubject (packages/core/src/Accounts.ts:74-96) is a ready-made directory-identity link: providerId="scim", subject=externalId. But no code or spec assigns this role, and the semantics have a trap: SCIM 2.0 carries both a server-assigned resource id and the directory's externalId, and a SCIM DELETE that removes the link row would strand an orphaned user — still signable via any other Account (e.g. password) with three live sessions — unless delete is explicitly wired to Users.delete or a tombstone. The identity anchor is present; the lifecycle semantics that make it safe are not.

## Evidence

Source: `packages/core/src/Accounts.ts:33`

```
export interface AccountRecord {
  readonly id: AccountId;
  readonly userId: UserId;
```

## Recommended fix

Record the mapping decision in spec/models/12-scim.md: SCIM resource id = internal UserId, externalId persisted as a scim-provider Account link; SCIM DELETE defined as link removal plus tombstone (not user deletion), with deactivate/delete postconditions observably different as the better-auth reference contract requires.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RRS-006` — AccountsRepository.update read-modify-write of all three secret columns is a lost-update hazard](medium/RRS-006-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `users-identity-model`. Evidence at HEAD ec065a7: `packages/core/src/Accounts.ts:33`. Fix: Record ticket 08/09's SCIM identity decisions in spec/models/12-scim.md (docs only). (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Closed by commit 4b63d9e (docs only): spec/models/12-scim.md rev 1.1 records the ticket 08/09 decisions — resource id = UserId; externalId in a scim-owned scim_external_id table (not an Accounts link); active:false -> Users.setStatus('suspended') + Sessions.revokeAll; DELETE -> unlink + configurable erase vs suspend with observably different postconditions; email-less directory users -> Anonymous/Phone identity, POST idempotent via createOrGet. spec:verify:strict PASS.
