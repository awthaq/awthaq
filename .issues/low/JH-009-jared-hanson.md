---
ID: "JH-009"
Title: "No authoring guide or template plugin — conventions live in code comments and test fixtures"
Level: low
Category: "docs"
Status: resolved
Package: "organization"
Source: "packages/organization/src/OrganizationHooks.ts:5"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-009 — No authoring guide or template plugin — conventions live in code comments and test fixtures

`LOW` · `docs` · `organization` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **resolved**

## Summary

A community strategy author must currently assemble the contract from: toy Ping/Pong classes in packages/core/test/AuthPlugin.test.ts:28-77, the dependsOn convention buried in Admin.ts:4-8, the config Context.Reference pattern in Password.ts:48-55, hook-point layer provisioning in examples/memory-server/index.ts:62-64, and the Jwt layer-merge trick in Jwt.ts:142-145. Every one of these is a per-file header comment or test fixture — the repo's own docs surface (README, spec/) describes intended design, not authoring steps. Passport's ecosystem succeeded because a strategy was ~60 lines against a documented interface; here the interface is excellent but the ramp is archaeology, and conventions discovered by comment-reading are conventions that get violated.

## Evidence

Source: `packages/organization/src/OrganizationHooks.ts:5`

```
// `Organization` is the first real plugin consumer of the core
// `HookPoint` mechanism (`packages/core/src/HookPoint.ts`,
// `BEH-EA-089`–`096`); there is no prior plugin example to mirror.
```

## Recommended fix

Add docs/plugin-authoring.md plus a checked-in minimal template plugin (config Reference, one contract group, tables + migration, one veto hook point, handlers) exercised by a test so it cannot rot; have the template be the file CI lints against rather than a second convention.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-008` — Hook veto aborts are converted to defects, crashing the request instead of denying it](medium/BE-008-bereket-engida.md) `_(bereket-engida, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `authz-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/organization/src/OrganizationHooks.ts:5`. Fix: Ship docs/plugin-authoring.md plus a minimal, test-exercised template plugin so conventions have one canonical, CI-checked home. (effort L). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** docs/plugin-authoring.md (contract, config Reference, dependsOn vs direct yield*, ports-required rule ADR-EA-010, hook tap-registry freeze, append-only dialect-branched migrations, HookAborted veto contract, house rules, checklist) and examples/plugin-template/ (a 'notes' plugin: config Reference + config(), one HttpApi group, one table with a dialect-branched migration, a records layer, a veto + an observe hook point, handlers). Its suite (examples/plugin-template/test/Template.test.ts, 11 tests, registered in the root vitest projects and tsconfig.test.json) builds via Auth.make, runs the real migration on SQLite, drives create/list over a real HttpRouter handler with a session cookie, checks 401, a typed 422 domain refusal, a veto abort (403 HookAborted, nothing stored), and runs TestAuth.runPluginContractTests. Linked from packages/core/README.md and AGENTS.md; OrganizationHooks header no longer claims there is no example. NOTE: adds a workspace member (examples/plugin-template) so pnpm-lock.yaml changed; expect a lockfile merge conflict to regenerate with pnpm install.
