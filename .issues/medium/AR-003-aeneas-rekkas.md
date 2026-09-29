---
ID: "AR-003"
Title: "Admin API shares the public surface — no separate tier, scheme, or network boundary"
Level: medium
Category: "architecture"
Status: resolved
Package: "admin"
Source: "packages/admin/src/AdminApi.ts:111"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-003 — Admin API shares the public surface — no separate tier, scheme, or network boundary

`MEDIUM` · `architecture` · `admin` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **resolved**

## Summary

The admin group (impersonate, stopImpersonating, forceStop, list) mounts under the same HttpApi.make("auth") id, same origin, and same cookie Authentication middleware as self-service endpoints; the only gate is AdminConfig.canImpersonate, an in-process predicate evaluated inside each handler (packages/admin/src/Admin.ts:42-47). In Ory's split, public and admin APIs are distinct HTTP surfaces precisely so operators can firewall the admin port and give it a different identity chain. Here a single XSS-adjacent mistake or an over-broad canImpersonate closure exposes privileged impersonation on the public attack surface, and there is no way to deploy the admin surface separately without forking the contract.

## Evidence

Source: `packages/admin/src/AdminApi.ts:111`

```
.middleware(Api.Authentication);
```

## Recommended fix

Keep the contract but make the tier swappable: compose AdminApi into a second HttpApi value served on a distinct route root/port by default, and/or add a dedicated middleware (service principal or mTLS-bound scheme) layered in front of Authentication for admin groups, with canImpersonate remaining as the in-handler policy backstop.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-009` — Admin path parameters are raw unvalidated strings; impersonate accepts nonexistent target users](low/APS-009-auth-pentest-specialist.md) `_(auth-pentest-specialist, low)_`
- [`EP-003` — Admin surface is impersonation-only; no user lifecycle or tenant administration](high/EP-003-eugenio-pace.md) `_(eugenio-pace, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `admin-api-tier`. Evidence at HEAD ec065a7: `packages/admin/src/AdminApi.ts:115`. Fix: Give admin groups a separable tier (own HttpApi + optional dedicated auth middleware), defaulting to today's co-hosted behavior. (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan (separable admin tier, defaulting to today's co-hosted behavior); user may revisit. Design (kept additive; no AuthPlugin.Class generics change): a contract group is admin-tier when any dot-separated segment of its id is 'admin' (BEH-EA-004 already confines ids to the plugin's own; AuthPlugin.isAdminTier at runtime, AdminTierId/AdminTierGroup at the type level, agreeing by construction). Auth.make now also returns publicApi (all groups except admin-tier) and adminApi (only admin-tier), each typed to exactly its groups via Exclude/Extract over GroupsOf<P[number]>, beside the unchanged api (all groups) - a host serves adminApi on its own listener/port with AuthHttp.routes(auth.adminApi) and publicApi elsewhere, handlers still from the one composed layer. @awthaq/api: new AdminAuthentication middleware (same security record/error/CurrentPrincipal as Authentication); @awthaq/server: AdminAuthenticationLive delegates to Authentication (co-hosted default unchanged; a host overriding it needs no Api.Authentication on an admin-only listener); @awthaq/admin: AdminGroup now sits behind Api.AdminAuthentication. Consequence: a host composing Admin must also provide AdminAuthenticationLive (default one-liner) - tests/BDD World updated. Deviation from the dossier's wording: no AuthHttp.layer({admin:{mount}}) option - AuthHttp.routes already takes any HttpApi, so choosing which api to serve IS the mount choice (the '/admin' path prefix already exists). Tests red first: core/test/AuthPlugin.test.ts 'AR-003: admin-tier groups are split into adminApi...' (runtime keys + @ts-expect-error type proof), admin/test/AdminTier.test.ts (publicApi-only listener answers /admin 404; admin listener with a swapped AdminAuthentication authenticates its own way; default scheme = ordinary session auth). Spec BEH-EA-071 amended (no new BEH id; see report). Gates: tsc -b (minus pre-existing packages/react TS2883) + tsconfig.test clean, pnpm test 860 pass, test:bdd 107, spec:verify:strict 19/19, oxlint clean.
