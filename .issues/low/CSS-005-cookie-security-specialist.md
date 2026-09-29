---
ID: "CSS-005"
Title: "README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "README.md:182"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-005 — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict

`LOW` · `docs` · `—` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **ready-for-agent**

## Summary

The quickstart's sample response header misstates the attribute set that the referenced composition actually produces: SESSION_COOKIE_ATTRIBUTES is sameSite:"strict" (packages/core/src/Sessions.ts:127), all five write sites reuse it, and the BDD step 'the cookie carries "Secure", "HttpOnly", and "SameSite=Strict"' (features/step-definitions/SessionSteps.ts:146) pins Strict against the real header. A developer eyeballing the quickstart would model the wrong CSRF posture (Lax vs Strict changes cross-site send behavior for top-level POST navigations).

## Evidence

Source: `README.md:182`

```
# set-cookie: __Host-session=...; Path=/; Secure; HttpOnly; SameSite=Lax
```

## Recommended fix

Correct the sample header to SameSite=Strict, or better, generate it from a real captured response so the doc cannot drift from SESSION_COOKIE_ATTRIBUTES.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 58/100), domain: Cookie & Set-Cookie security
- Full dossier: [`cookie-security-specialist`](../../.reports/cookie-security-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:182`. Fix: Correct the sample header to SameSite=Strict and add one sentence explaining why OAuth uses its own Lax __Host-oauth-state flow cookie (IC-005's addition). (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
