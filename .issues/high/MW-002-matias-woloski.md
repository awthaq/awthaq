---
ID: "MW-002"
Title: "Served API surface is fragmented across three HttpApi values; core session/account routes are unreachable via Auth.make"
Level: high
Category: "api"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Auth.ts:374"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-002 — Served API surface is fragmented across three HttpApi values; core session/account routes are unreachable via Auth.make

`HIGH` · `api` · `core` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **ready-for-agent**

## Summary

composeApi mounts only plugin contract groups, and packages/api/src/index.ts:12-13 confirms folding the session/account groups is 'Planned next'. The standalone AuthCoreApi (packages/api/src/AuthCore.ts:16, id "auth") and SubjectApi (packages/api/src/Subject.ts:58, id "auth-subject") produce a deployment that must register up to three separate HttpApi documents — with real handlers for /session/* and /user already written in @awthaq/server that the composition path never mounts (examples/memory-server/index.ts serves only built.api). For an SDK consumer, 'give me one server with all auth routes' is not one call today, and OpenAPI/Scalar docs are split across documents.

## Evidence

Source: `packages/core/src/Auth.ts:374`

```
const groups = order.flatMap((plugin) => Object.values(plugin.contract.groups));
  const [firstGroup, ...restGroups] = groups;
```

## Recommended fix

Land BEH-EA-032: make Auth.make prepend the core session/account groups to the composed api and accept a SubjectResolver-provided subject group, so one HttpApi value (id "auth") carries the full surface and one AuthHttp.routes call serves it.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EHA-001` — Duplicate group-id refusal (BEH-EA-032) unimplemented: colliding groups silently overwrite](high/EHA-001-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`JH-006` — Static layer type matches the runtime fold only when the tuple is pre-sorted](medium/JH-006-jared-hanson.md) `_(jared-hanson, medium)_`
- [`MA-007` — Built<P>['layer']'s static type assumes caller-side dependency ordering the runtime does not require](medium/MA-007-michael-arnaldi.md) `_(michael-arnaldi, medium)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [HttpApi surface consolidation (Auth.make)](../../.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) — `composeApi` now seeds the flatMap with `AuthCore.AuthCoreApi`'s `session`/`account` groups before folding plugin groups, and `Auth.make` gains an optional `extraGroups` parameter so the composition root can add qadi's subject group; `@awthaq/server` gets a new `AuthHttp.coreHandlers` convenience layer. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `composeApi` (packages/core/src/Auth.ts:371-380) flatMaps only `plugin.contract.groups`; `AuthCoreApi` (packages/api/src/AuthCore.ts:16, id "auth") and `SubjectApi` (packages/api/src/Subject.ts:58, id "auth-subject") are separate standalone `HttpApi` values never referenced there. Confirmed via packages/test/src/TestAuth.ts:162, which calls `AuthHttp.routes(built.api, {})` — only the composed plugin api — so examples/memory-server indeed serves only `built.api`. Genuinely needs an architectural decision (how to merge three HttpApi documents, whether SubjectResolver wiring belongs in core), not a pure mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `httpapi-surface-consolidation`. Evidence at HEAD ec065a7: `packages/core/src/Auth.ts:393`. Fix: Implement ticket 26: composed api always carries core session/account groups, optional extraGroups for qadi's subject group, AuthHttp.coreHandlers convenience, and update every composition site. (effort L). Full dossier: `.plan/slices/01-core-sessions-users.md`.
