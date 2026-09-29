---
ID: "AVS-002"
Title: "Seven parallel standalone `HttpApi` values; core groups not yet folded into Auth.make's composed api"
Level: medium
Category: "architecture"
Status: resolved
Package: "api"
Source: "packages/api/src/AuthCore.ts:16"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-002 — Seven parallel standalone `HttpApi` values; core groups not yet folded into Auth.make's composed api

`MEDIUM` · `architecture` · `api` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

`Auth.make` composes its api from plugin contracts (packages/core/src/Auth.ts:379), but the core `session`/`account` groups and qadi's `subject` group exist only as standalone `HttpApi.make("auth")` / `HttpApi.make("auth-subject")` values in @awthaq/api and @awthaq/qadi, and each plugin package additionally exports its own standalone `PasswordApi`/`PasskeyApi`/`JwtApi`/`OAuthApi` consts with the same "auth" id. The fold-in (BEH-EA-032) is tracked only in header comments. Until it lands, a consumer assembling a real server must manually mount several disjoint api values whose root-level path spaces overlap (password's `/verify-email` etc. live beside core's `/user`), and when the fold lands, `Auth.make`'s output group set changes — a consumer-visible contract change that deserves a planned, announced migration, not an incidental one.

## Evidence

Source: `packages/api/src/AuthCore.ts:16`

```
export const AuthCoreApi = HttpApi.make("auth").add(SessionGroup).add(AccountGroup);
```

## Recommended fix

Treat the fold-in as a versioned milestone: land core groups in `Auth.make`, keep the standalone consts as deprecated aliases for one release with changeset notes, and add a changeset discipline (see AVS-009) so the convergence is communicated as the breaking-shaped change it is.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-006` — Core and plugin routes split across two HttpApi contracts](medium/BE-006-bereket-engida.md) `_(bereket-engida, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `httpapi-surface-consolidation`. Duplicate of `MW-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Auth.ts:390`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
