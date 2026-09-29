---
ID: "EP-003"
Title: "Admin surface is impersonation-only; no user lifecycle or tenant administration"
Level: high
Category: "api"
Status: ready-for-agent
Package: "admin"
Source: "packages/admin/src/AdminApi.ts:82"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-003 — Admin surface is impersonation-only; no user lifecycle or tenant administration

`HIGH` · `api` · `admin` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **ready-for-agent**

## Summary

The whole admin package is four endpoints — impersonate, stopImpersonating, forceStop, list (AdminApi.ts:82-113) — all impersonation. There is no user list/search, no block/disable, no delete, no admin-forced session revocation, no tenant settings. An IAM suite's minimum admin API (support workflows beyond impersonation: suspend an abusive account, enumerate a user's sessions, purge PII on request) is absent, and the fail-closed `canImpersonate` default (Admin.ts:47) means even impersonation is inert until the host writes the gate.

## Evidence

Source: `packages/admin/src/AdminApi.ts:82`

```
export const AdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("impersonate", "/admin/impersonate/:userId", {
```

## Recommended fix

Grow @awthaq/admin behind the same gate pattern: user search/list, block/unblock with typed errors, admin-initiated session revocation, and a redaction-respecting delete. Each is small against the existing Users/Sessions services; the impersonation gate (deny-by-default predicate) is the right template.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-003` — Admin API shares the public surface — no separate tier, scheme, or network boundary](medium/AR-003-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`APS-009` — Admin path parameters are raw unvalidated strings; impersonate accepts nonexistent target users](low/APS-009-auth-pentest-specialist.md) `_(auth-pentest-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/admin/src/AdminApi.ts:82-84` exactly; `AdminGroup` (lines 82-111) has exactly the four cited endpoints, all impersonation, and `Admin.ts:47` (`canImpersonate: () => Effect.succeed(false)`) confirms the fail-closed default. Deciding and building a user-lifecycle/tenant-admin surface (search, block, forced revocation, redaction-respecting delete) is a product-scope decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Admin API surface expansion beyond impersonation](../../.scratch/resolve-ready-for-human-findings/issues/19-admin-api-surface-expansion.md) — Resolved via the same admin-surface growth described in the ticket, plus a superadmin-only tenant-admin slice (`listOrganizations`/`suspendOrganization`) built on Ticket 18's organization-as-tenant model, gated behind a new optional `Admin.layerWithTenants` variant. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `admin-surface-expansion`. Evidence at HEAD ec065a7: `packages/admin/src/AdminApi.ts:82`. Fix: Implement ticket 19 §3: an optional superadmin tenant-administration sub-surface on top of BAM-005's user/session admin. (effort L). Full dossier: `.plan/slices/10-passkey-admin.md`.
