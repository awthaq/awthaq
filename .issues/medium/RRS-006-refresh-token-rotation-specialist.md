---
ID: "RRS-006"
Title: "AccountsRepository.update read-modify-write of all three secret columns is a lost-update hazard"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Accounts.ts:424"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-006 — AccountsRepository.update read-modify-write of all three secret columns is a lost-update hazard

`MEDIUM` · `api` · `core` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **ready-for-agent**

## Summary

Because the three sensitive columns are included in the generic update rather than excluded, every caller must read the row and pass the secrets it is not changing through unchanged (core layerSql does this at Accounts.ts:423-446; the repository re-reads again at Repositories.ts:244-259). The read-pass-through-write sequence has no optimistic guard, so two concurrent writers — e.g. rehash-on-login's updateCredentialHash and any future provider-token-refresh writer — last-writer-wins: the loser silently reinstates stale tokens over the winner's freshly stored ones. Latent today only because no production code writes non-null tokens (RRS-007); the Shape guarantees the bug the moment a refresh flow lands.

## Evidence

Source: `packages/core/src/Accounts.ts:424`

```
// `passwordHash`/`accessToken`/`refreshToken` are all `Model.Sensitive`,
    // included together in the generic `update` (only the non-sensitive
    // identity fields are `FieldExcept`-excluded)
```

## Recommended fix

Offer targeted per-secret writes (the updateCredentialHash pattern generalized to accessToken/refreshToken) or guard the generic update with a compare-and-swap on updatedAt, so concurrent credential and token writers cannot clobber each other.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SCP-005` — External-id mapping substrate exists in Accounts but the SCIM id/externalId mapping decision is undocumented](medium/SCP-005-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `accounts-targeted-writes`. Evidence at HEAD ec065a7: `packages/core/src/Accounts.ts:600`. Fix: Replace read-pass-through writes with column-targeted UPDATE statements (no read needed) so writers of one secret never rewrite another. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
