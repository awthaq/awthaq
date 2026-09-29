---
ID: "NHS-009"
Title: "OpenAPI/Scalar docs served unauthenticated in the canonical composition"
Level: low
Category: "security"
Status: resolved
Package: "—"
Source: "README.md:134"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-009 — OpenAPI/Scalar docs served unauthenticated in the canonical composition

`LOW` · `security` · `—` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

The quickstart's AppLayer unconditionally merges AuthHttp.docs(auth.api) alongside routes, so /openapi.json and the Scalar UI ship on :3000 with no authentication and no toggle; the same pattern appears in packages/server/test/AuthHttp.test.ts:361 (/docs) and the password plugin's own tests. For a pre-auth reconnaissance pass, the machine-readable spec enumerates the entire endpoint surface, payload shapes, and error taxonomy — useful for integrators in dev, an unnecessary information leak in prod, and nothing in the docs or the layer marks it as dev-only.

## Evidence

Source: `README.md:134`

```
  AuthHttp.docs(auth.api),
```

## Recommended fix

Gate docs behind a config flag or a separate admin-only layer in the quickstart, and document that production compositions should omit AuthHttp.docs unless the surface is intentionally public.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:128`. Fix: Keep AuthHttp.docs as specified (BEH-EA-084) but make the quickstart/example gate it behind a Config flag defaulting off, and document that production compositions should omit it or put it behind their own auth. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** The README quickstart mounts AuthHttp.docs and the openapi route only when AWTHAQ_EXPOSE_DOCS=true (Config.Boolean with default false), verified against a running composition (404 and 404 with it unset, 200 and 200 with it set); a new README section 'OpenAPI and the docs UI' states the production posture and points at awthaq openapi. Deferred: the caution comment on AuthHttp.docs in packages/server (source file, outside this docs-only program) and the same gating in examples/sql-server (P20b).
