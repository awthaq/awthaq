---
ID: "IC-005"
Title: "Quickstart copy-paste output shows SameSite=Lax where the code sets Strict"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "README.md:182"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-005 — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict

`LOW` · `docs` · `—` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

The quickstart's annotated curl output — the snippet new users compare against their own first run — shows SameSite=Lax, but the only cookie attributes the server ever emits are SESSION_COOKIE_ATTRIBUTES with sameSite: "strict" (packages/core/src/Sessions.ts:124-129, asserted verbatim in packages/core/test/Sessions.test.ts:345-350). The very first observed behavior contradicts the docs. It also invites the question the docs never answer: a Strict session cookie is not sent on cross-site top-level navigations, which matters for link-in flows landing back on the app from an IdP; the OAuth plugin compensates with its own Lax __Host-oauth-state flow cookie (packages/oauth/src/OAuth.ts:308-314), but nothing tells the reader that is why.

## Evidence

Source: `README.md:182`

```
# set-cookie: __Host-session=...; Path=/; Secure; HttpOnly; SameSite=Lax
```

## Recommended fix

Correct the README to SameSite=Strict and add one sentence explaining the Lax flow-cookie division of labor in the OAuth callback.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `readme-docs-accuracy`. Duplicate of `CSS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `README.md:182`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
