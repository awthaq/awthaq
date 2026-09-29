---
ID: "MW-008"
Title: "SessionDto date fields typed as unconstrained Schema.String — format is convention, not contract"
Level: low
Category: "api"
Status: ready-for-agent
Package: "api"
Source: "packages/api/src/Session.ts:20"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-008 — SessionDto date fields typed as unconstrained Schema.String — format is convention, not contract

`LOW` · `api` · `api` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **ready-for-agent**

## Summary

createdAt/lastActiveAt/expiresAt are Schema.String in the wire contract; only the server's toDto (packages/server/src/Session.ts:18-20) happens to emit DateTime.formatIso. Generated OpenAPI clients see bare strings with no date-time format, so non-Effect consumers must reverse-engineer the encoding, and a future handler returning 'in 5 minutes' or local-time strings would still type-check. For a contract-first SDK this erodes the schema's promise.

## Evidence

Source: `packages/api/src/Session.ts:20`

```
lastActiveAt: Schema.String,
```

## Recommended fix

Use Effect Schema's date-time/ISO-8601 schema for these fields (or a branded IsoDateString) so the encoding is enforced at the contract stratum, not by one handler's good behavior.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CDS-004` — No-payload mutating POSTs bypass the JSON content-type gate — SameSite-only defense for logout and kill-switch endpoints](medium/CDS-004-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-004` — Core session/account groups never composed: Auth.make's served api has no session endpoints](medium/EHA-004-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`SMS-005` — signOut/revokeAll never clear the session cookie from the browser](low/SMS-005-session-management-specialist.md) `_(session-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `api-contract-tests`. Evidence at HEAD ec065a7: `packages/api/src/Session.ts:18`. Fix: Make SessionDto's timestamps a real contract: Schema.DateTimeUtcFromString on the wire (an ISO string) that decodes to DateTime.Utc. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
