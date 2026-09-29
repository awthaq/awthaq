---
ID: "EHA-004"
Title: "Core session/account groups never composed: Auth.make's served api has no session endpoints"
Level: medium
Category: "architecture"
Status: resolved
Package: "api"
Source: "packages/api/src/Session.ts:7"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-004 — Core session/account groups never composed: Auth.make's served api has no session endpoints

`MEDIUM` · `architecture` · `api` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **resolved**

## Summary

Auth.make's composeApi only folds plugin.contract.groups (packages/core/src/Auth.ts:374), so the reserved core groups (session, account) in AuthCoreApi and the subject group in qadi's SubjectApi exist as standalone HttpApi values that no composition path merges with the plugin-composed api. TestAuth.layer and the example memory-server serve only built.api (packages/test/src/TestAuth.ts:162), meaning the flagship session-management surface (GET /auth/session, revoke, revoke-others, revoke-all) and account deletion are absent from every default composition and must be hand-wired via a separate AuthHttp.routes(AuthCoreApi, ...) registration — exactly what only the server tests do. Two disjoint top-level HttpApi values also share the 'auth' id, so OpenAPI generation and the client's ErrorCodes derivation over 'the composed api' each see only half the surface.

## Evidence

Source: `packages/api/src/Session.ts:7`

```
to exist at all. Not yet folded into `Auth.make`'s composed `api`
```

## Recommended fix

Fold AuthCoreApi's groups into composeApi (prefixing core groups before plugin groups), or export a composed Auth.api that unions built.api with AuthCoreApi so routes/docs/client all derive from one value, closing the BEH-EA-031/032 follow-up the package headers already track.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CDS-004` — No-payload mutating POSTs bypass the JSON content-type gate — SameSite-only defense for logout and kill-switch endpoints](medium/CDS-004-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`MW-008` — SessionDto date fields typed as unconstrained Schema.String — format is convention, not contract](low/MW-008-matias-woloski.md) `_(matias-woloski, low)_`
- [`SMS-005` — signOut/revokeAll never clear the session cookie from the browser](low/SMS-005-session-management-specialist.md) `_(session-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `httpapi-surface-consolidation`. Duplicate of `MW-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Auth.ts:390`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
