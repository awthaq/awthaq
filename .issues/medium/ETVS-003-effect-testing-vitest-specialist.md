---
ID: "ETVS-003"
Title: "Five packages ship vitest configs with no tests; contract stratum @awthaq/api untested directly"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "api"
Source: "packages/api/vitest.config.ts:6"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-003 — Five packages ship vitest configs with no tests; contract stratum @awthaq/api untested directly

`MEDIUM` · `testing` · `api` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **ready-for-agent**

## Summary

packages/api, api-key, cli, magic-link and two-factor each carry a vitest.config.ts but have no test/ directory. Four are honest empty placeholders (e.g. two-factor/src/index.ts is `export {};`), but @awthaq/api holds real, security-relevant code (145-line Api.ts with the Principal union, Unauthenticated error, middleware declarations) whose only exercise is indirect, through other packages' wire tests. Its schema decode/encode error paths have no direct owner, and the config-only placeholder packages make 'has vitest config' meaningless as a coverage signal.

## Evidence

Source: `packages/api/vitest.config.ts:6`

```
  test: {
    include: ["test/**/*.test.ts"],
```

## Recommended fix

Add a focused packages/api/test suite (Principal decode of every member tag, Unauthenticated status mapping, CurrentPrincipal no-default contract). Drop vitest.config.ts from the four placeholder packages until they have source, or add a CI guard (a few lines on top of the existing knip script) that fails any package with src/ but no test/.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `api-contract-tests`. Evidence at HEAD ec065a7: `packages/api/vitest.config.ts:3`. Fix: Give @awthaq/api a direct test suite for its security-relevant contract. The placeholder-package half goes to the tooling slice. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
