---
ID: "NHS-008"
Title: "No request-id/correlation middleware or access logging at the serving stratum"
Level: low
Category: "dx"
Status: resolved
Package: "server"
Source: "packages/server/src/index.ts:10"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-008 — No request-id/correlation middleware or access logging at the serving stratum

`LOW` · `dx` · `server` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

The package surface is exactly Account/Authentication/AuthHttp/Csrf/Session — there is no logging, tracing, or request-id module, and a repo-wide grep for X-Request-Id/requestId finds nothing; the only correlation token anywhere is OAuth's opaque state cookie (OAuth.ts:308). Combined with NHS-002's status flattening, an operator debugging a burst of 401s or 429s has no identifier to correlate across services, no access log from the framework layer, and no hook point that packages/server offers to add one.

## Evidence

Source: `packages/server/src/index.ts:10`

```
export * as Account from "./Account.ts";
export * as Authentication from "./Authentication.ts";
export * as AuthHttp from "./AuthHttp.ts";
```

## Recommended fix

Ship an optional request-id middleware in @awthaq/server (generate or propagate X-Request-Id, expose it to handlers via context, echo on responses) plus an access-log hook, and wire both into the README quickstart.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `observability-substrate`. Duplicate of `MW-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/index.ts:10`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MW-001-matias-woloski` — closed by its fix (see that issue's Resolved comment).
