---
ID: "MTS-010"
Title: "Test-only workspace imports declared as runtime dependencies"
Level: low
Category: "correctness"
Status: resolved
Package: "admin"
Source: "packages/admin/package.json:36"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-010 — Test-only workspace imports declared as runtime dependencies

`LOW` · `correctness` · `admin` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **resolved**

## Summary

packages/admin/src never imports @awthaq/server (its one mention is a comment); only admin/test/Admin.test.ts:10 and AuthHttp.test.ts:10 do. The dependency sits in `dependencies` (line 36) rather than devDependencies — same pattern in packages/test, whose src imports core/ports/server but whose `dependencies` entry @awthaq/api (test/package.json:34) is exercised only by test/TestAuth.test.ts. In a private workspace this costs nothing today, but the manifests are deliberately kept publish-shaped (attw/publint smoke runs per package), and on publish the misclassification forces every @awthaq/admin consumer to install @awthaq/server. Neither publint nor attw checks dependency classification, so nothing in `pnpm check` catches the next instance.

## Evidence

Source: `packages/admin/package.json:36`

```
    "@awthaq/server": "workspace:*",
```

## Recommended fix

Move test-only imports (admin's @awthaq/server, test's @awthaq/api) to devDependencies; consider extending package-smoke.mjs with a src-imports-vs-dependencies assertion so classification stays publish-true.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `package-and-test-hygiene`. Evidence at HEAD ec065a7: `packages/admin/package.json:30`. Fix: Reclassify test-only workspace deps and add a src-imports-vs-dependencies smoke check so the drift cannot recur. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/organization (@awthaq/server), packages/scim (@awthaq/api) and packages/test (@awthaq/api) moved to devDependencies; packages/scim's @awthaq/ports (imported by its built lib) moved the other way to dependencies. scripts/package-smoke.mjs now compares each package's built lib/*.js and *.d.ts imports with dependencies/peerDependencies both ways (red before the moves: it reported scim's ports; test-only deps reported as unused). package:smoke, knip, workspace:check green. packages/admin had already been fixed.
