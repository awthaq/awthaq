---
ID: "CWM-007"
Title: "README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "README.md:232"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-007 — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter

`LOW` · `docs` · `—` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

A migration assessment starts from the README's shipping status, and this line undercounts what exists: packages/next/src/index.ts exports four real, tested modules (getSession with DB-verified session resolution per BEH-EA-185, hasSessionCookie, withNextCookies cookie bridging per BEH-EA-189, plus types) — 344 lines of implementation, not a 10-line export-{} stub. .scratch/shipping-gaps/map.md:138 carries the same stale claim. The practical effect for a Clerk migrant is underestimating the Next.js surface they do get (server-side session resolution exists; what is missing is route middleware and client provider glue) and possibly re-planning work that is already done.

## Evidence

Source: `README.md:232`

```
`two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages — see [`.scratch/shipping-gaps/map.md`](.scratch/shipping-gaps/map.md)'s "Out of scope" section for why they're deliberately not part of this pass.
```

## Recommended fix

Update README.md:232 and the shipping-gaps map to reflect next's current four exports (and re-verify the other named packages while there), keeping the honest 'what is still missing' framing but accurate.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `readme-docs-accuracy`. Duplicate of `DTWS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `README.md:232`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
