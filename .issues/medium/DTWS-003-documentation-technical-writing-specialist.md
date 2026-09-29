---
ID: "DTWS-003"
Title: "Root README lists @awthaq/next as a stub package; it has a real implementation"
Level: medium
Category: "dx"
Status: resolved
Package: "—"
Source: "README.md:232"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-003 — Root README lists @awthaq/next as a stub package; it has a real implementation

`MEDIUM` · `dx` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **resolved**

## Summary

The Plugins section's stub list includes next, but packages/next/src contains real modules (GetSession.ts, HasSessionCookie.ts, WithNextCookies.ts, CookieHeader.ts); GetSession.ts:5 describes itself as 'The real, database-verified boundary: called from a React Server Component or a server action, it resolves the incoming request's session cookie against @awthaq/core's Sessions service'. A developer scoping Next.js work from the README would wrongly assume greenfield. Notably the actual stub set is api-key, cli, magic-link, two-factor — next is the one package whose README was updated, yet the root README's claim about it is the stale one.

## Evidence

Source: `README.md:232`

```
`two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages
```

## Recommended fix

Remove `next` from the stub list (and note what it does ship: session resolution, cookie presence check, Next server helpers); keep the list to api-key, cli, magic-link, two-factor.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:232`. Fix: Correct the README's plugin/package inventory: remove `next` from the stub list, add a row describing what @awthaq/next ships, and fix the same claim in .scratch/shipping-gaps/map.md. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** README.md no longer lists next as a stub: the 'Around the plugins' table describes getSession, hasSessionCookie and withNextCookies (and the edge and serverActionClient entries); only two-factor and magic-link are called placeholders. Deferred: .scratch/shipping-gaps/map.md's same claim, because the brief bars staging .scratch/. CWM-007 closes as its duplicate.
