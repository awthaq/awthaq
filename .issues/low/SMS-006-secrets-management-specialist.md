---
ID: "SMS-006"
Title: "README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "README.md:75"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-006 — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config

`LOW` · `dx` · `—` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **ready-for-agent**

## Summary

The quickstart contradicts the codebase's own convention for secret/config loading. With the variable unset, process.env.DATABASE_URL! silently coerces undefined into a Redacted<string> and the connection fails downstream with a driver-level error far from the cause - precisely the 'confusing downstream error' the KeyProvider design comments set out to avoid (packages/ports/src/KeyProvider.ts:67-69: a missing key surfaces as a Config.ConfigError). It also wraps the URL in Redacted manually instead of via Config, losing typed loading entirely.

## Evidence

Source: `README.md:75`

```
const SqlLive = PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) });
```

## Recommended fix

Show the Config path in the quickstart: read Config.Redacted("DATABASE_URL") through Effect.config (or ConfigProvider.fromEnv) so a missing URL is a typed, loud ConfigError at layer construction, matching AWTHAQ_ENCRYPTION_KEY's behavior.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`IC-010` — First real run requires hand-generating a base64 32-byte key; no dev auto-generation](low/IC-010-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:75`. Fix: Load DATABASE_URL through Config (`PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })`) — and, because validation shows the whole quickstart has drifted into not type-checking (Mailer shape, missing AuditLog, missing CsrfProtection), move the quickstart into a real, workspace-typechecked example that the README embeds/links so it can never drift again. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
