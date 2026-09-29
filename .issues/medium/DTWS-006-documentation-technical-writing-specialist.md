---
ID: "DTWS-006"
Title: "spec/README.md claims the BDD suite has 'no test runner, no step-definition layer' — features/ has both"
Level: medium
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/README.md:126"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-006 — spec/README.md claims the BDD suite has 'no test runner, no step-definition layer' — features/ has both

`MEDIUM` · `docs` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **resolved**

## Summary

The features/ directory now contains a full step-definition layer (features/step-definitions/PasswordSteps.ts, SessionSteps.ts, OAuthSteps.ts, PasskeySteps.ts, AdminSteps.ts, SmokeSteps.ts + World files), executable scenario suites (15/16/17/07/27 *.steps.test.ts), and vitest.config.ts, and the root package.json wires them as pnpm test:bdd. The spec's claim that BEH-EA-193-200 'remain unimplemented' with no runner is stale, so the document both understates the repo's verification story and misdirects readers hunting for where scenarios are executed.

## Evidence

Source: `spec/README.md:126`

```
it is **not** itself proof that anything holds at runtime: there is still no test runner, no step-definition layer, and no Cucumber configuration
```

## Recommended fix

Update the section to name vitest + features/step-definitions/ as the current runner and step layer, cite the actual steps test files, and keep only the genuinely-unimplemented remainder of BEH-EA-193-200 (if any) as the open gap.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DTWS-001` — spec/README.md's honesty banner asserts there is no source tree, no CI, no package.json — all false](high/DTWS-001-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-bdd-traceability-refresh`. Evidence at HEAD ec065a7: `spec/README.md:126`. Fix: Rewrite every 'no runner / no step layer' claim to describe the real suite: vitest + @effect-cucumber/vitest, features/step-definitions/, 6 wired / 22 `@skip @unwired` feature files, run by `pnpm test:bdd` inside `pnpm check`. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Every 'no runner / no step layer' claim now describes the real suite: spec/README.md, spec/traceability.md section 6, definitions-of-done.md, requirement-id-scheme.md and features/README.md name pnpm test:bdd, @effect-cucumber/vitest, features/step-definitions/, the wired feature files (sessions, password, oauth, passkey, admin-impersonation, plus _smoke) and the rest as @skip @unwired; no counts are hard-coded so they cannot drift. BEH-EA-193..200 are described as implemented in @awthaq/test (194-196 are patterns over Effect's and qadi's helpers). Gates: pnpm run typecheck clean, pnpm run spec:verify:strict 28/28, pnpm run check:readmes green.
