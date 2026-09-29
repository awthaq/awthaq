---
ID: "BE-004"
Title: "Reactive React client covers only the core session; plugin routes need hand-built clients"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "react"
Source: "packages/react/src/AuthClientAtom.ts:13"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-004 — Reactive React client covers only the core session; plugin routes need hand-built clients

`MEDIUM` · `dx` · `react` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **ready-for-agent**

## Summary

better-auth's client merges server plugins into one inferred authClient via mirrored client plugins, so `authClient.organization.create()` just exists. effect-auth's server-side inference is strong (HttpApiClient re-exports in packages/client/src/AuthClient.ts:51-57 preserve literal group precision, and ErrorCodes derives error unions from the contract), but the reactive layer explicitly cannot know the composed api: every plugin endpoint requires the application to hand-write its own AtomHttpApi.Service. The client-keeps-in-sync-with-server problem the plugin contract solves at type level is reintroduced at the reactive layer by hand.

## Evidence

Source: `packages/react/src/AuthClientAtom.ts:13`

```
// `ReactAuthClient` is built against `@awthaq/api`'s `AuthCore.AuthCoreApi`
// specifically — the one fixed contract every awthaq composition serves
// regardless of which plugins are installed
```

## Recommended fix

Export a generic `makeReactClient(api)` factory over AtomHttpApi (already generic in effect/unstable/reactivity) so one call on an app's composed `auth.api` yields typed atoms for every installed plugin group.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-005` — packages/react exposes no organization atoms — an app migrating Clerk's OrganizationSwitcher must hand-build its own reactive layer](medium/CWM-005-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`PCS-007` — Client-side decision invalidation is a disconnected model: reactivity keys, no server push](info/PCS-007-permission-caching-specialist.md) `_(permission-caching-specialist, info)_`
- [`RSC-004` — BEH-EA-179's derive-subject-from-sessionAtom and same-render sign-out guarantee is not what shipped](medium/RSC-004-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `react-client-atoms-factory`. Evidence at HEAD ec065a7: `packages/react/src/AuthClientAtom.ts:37`. Fix: Export a generic reactive-client factory over an app's composed `auth.api`, carrying CSRF + transport options, and rebuild the built-in session/subject atoms on it. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
