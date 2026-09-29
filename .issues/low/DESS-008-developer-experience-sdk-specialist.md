---
ID: "DESS-008"
Title: "Quickstart offers no zero-database path and does not mention the runnable example"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "README.md:170"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-008 — Quickstart offers no zero-database path and does not mention the runnable example

`LOW` · `docs` · `—` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **ready-for-agent**

## Summary

The root quickstart — the first thing a new consumer runs — requires a provisioned Postgres, a generated 32-byte encryption key, and a 118-line composition file (README.md:44-162) before the first sign-up succeeds. examples/memory-server solves exactly this (0 env vars, 1 command) yet is never referenced from the quickstart or 'Running it' sections; a newcomer evaluating the library must either stand up Postgres or discover the example by reading package listings. This is avoidable time-to-first-success cost, the metric a DX reviewer optimizes first.

## Evidence

Source: `README.md:170`

```
export DATABASE_URL="postgres://user:pass@localhost:5432/awthaq"
export AWTHAQ_ENCRYPTION_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
node --experimental-strip-types server.ts
```

## Recommended fix

Add a one-line callout at the top of the quickstart: 'No database handy? cd examples/memory-server && node --experimental-strip-types index.ts for a zero-config server on :3001' (once DESS-002 makes its sign-in completable).

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:170`. Fix: Add a 'No database handy?' callout at the top of the Quickstart pointing to examples/memory-server (and to examples/sql-server's SQLite default from SEA-007/SMS-006), once DESS-002 makes the example's sign-in completable. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Plan note (2026-09-29):** Partly done in P19: README's Quickstart now opens with a 'No database handy?' callout pointing at examples/memory-server (a Password + Organization + Roles server over the memory backend, no env vars) and the repo map lists examples/. Left open because the dossier gates the callout on DESS-002 (a completable sign-in in that example) and examples/ is P20b's: the memory Mailer still drops the verification mail, so the linked path cannot yet complete a sign-in, and the README says so instead of promising it. When DESS-002 lands, reword the callout and close.
