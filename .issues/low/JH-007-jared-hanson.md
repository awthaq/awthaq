---
ID: "JH-007"
Title: "dependsOn de-facto governs only migration order while requirements go through RIn"
Level: low
Category: "api"
Status: resolved
Package: "admin"
Source: "packages/admin/src/Admin.ts:4"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-007 — dependsOn de-facto governs only migration order while requirements go through RIn

`LOW` · `api` · `admin` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **resolved**

## Summary

BEH-EA-008 documents dependsOn as declaring "both migration ordering and a typed requirement in one array", but the established convention across Admin and Organization is to leave it unset and yield core services directly — the typed requirement rides the layer's RIn, which provideMerge resolves independent of dependsOn. The two channels can drift: a plugin that reads another plugin's tables (or seeds rows in its own migrations) gets correct service wiring with wrong migration order, since renumberMigrations (Auth.ts:336-349) sequences strictly by dependsOn. Nothing checks that a plugin whose runtime behavior touches another plugin's data declared the dependency. Passport's lesson: implicit ordering conventions are exactly what bit strategy authors for a decade.

## Evidence

Source: `packages/admin/src/Admin.ts:4`

```
// `Auth.make([Admin])` composes: `dependsOn` is left unset on
// `AuthPlugin.layer` — `Sessions`/`Users`/`AuthEvents` are core domain
// services this plugin's own `make` Effect simply `yield*`s directly, the
```

## Recommended fix

Document dependsOn as migration/persistence-ordering only (and rename if a breaking window allows), or add a composition-time lint in Auth.make: warn when a plugin's migrations reference tables (`NNNN_<plugin>_` prefixes are visible) it did not declare in dependsOn.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-006` — Impersonation cookie overwrite strands the admin's own live session with no handback](medium/APS-006-auth-pentest-specialist.md) `_(auth-pentest-specialist, medium)_`
- [`BAM-002` — All 11 plugin-owned tables have SQL layers but zero DDL](high/BAM-002-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-005` — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface](high/BAM-005-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`BAM-012` — Impersonation semantics differ from better-auth's cookie-swap model](info/BAM-012-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, info)_`
- [`CSS-003` — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie](medium/CSS-003-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`IDS-001` — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account](high/IDS-001-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, high)_`
- [`IDS-003` — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target](medium/IDS-003-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- [`IDS-005` — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token](medium/IDS-005-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, medium)_`
- … 5 more findings touch `packages/admin/src/Admin.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `plugin-contract-docs`. Evidence at HEAD ec065a7: `spec/behaviors/01-plugin-contract.md:148`. Fix: Align BEH-EA-008 with the shipped convention and make the plugin-to-plugin data dependency explicit where it matters. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-008 example now plugin-to-plugin (TwoFactor dependsOn Password) with the shipped convention stated (core services via yield*, dependsOn = other plugins + sole migration order); AuthPlugin.Service option readsTables + Auth.UndeclaredTableDependency thrown by Auth.make when an installed plugin owns a read table without being in dependsOn (test in AuthPlugin.test.ts). No shipped plugin declares readsTables yet (none is real today, per dossier). docs/plugin-authoring.md updated with the JH-006/007/008/MA-005 rules.
