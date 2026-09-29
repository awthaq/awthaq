---
ID: "CTA-001"
Title: "CLI package has zero auth surface and its planned command set contains no login command"
Level: high
Category: "architecture"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:8"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-001 — CLI package has zero auth surface and its planned command set contains no login command

`HIGH` · `architecture` · `cli` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **resolved**

## Summary

The entire CLI package is 10 lines exporting nothing. The planned command set (packages/cli/src/index.ts:3 — doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import) is pure operator tooling: no command authenticates a human, no command accepts a credential, and the supporting spec (spec/behaviors/26-cli.md, BEH-EA-201–208) never mentions login. Everything this persona's domain requires — device-flow or callback login, credential storage, token refresh UX — has no home in the CLI's own plan, not merely no implementation.

## Evidence

Source: `packages/cli/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

## Recommended fix

Before writing any CLI code, add an explicit authentication story to spec/behaviors/26-cli.md (a login command plus its storage and refresh contract), or formally scope terminal login to another surface (e.g. @awthaq/client) and say so in both the spec and this package's README.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`FAMS-010` — No bulk user-import tooling; the planned CLI import command is unimplemented](medium/FAMS-010-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/cli/src/index.ts:8` is exactly the quoted placeholder comment; the whole file is 10 lines with `export {};`. `spec/behaviors/26-cli.md` has zero occurrences of "login". Deciding whether CLI login belongs in `@awthaq/cli` or `@awthaq/client` (and amending the spec accordingly) is a product/architecture decision, not a mechanical fix. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [CLI login flow design vs. the BEH-EA-208 network-boundary prohibition](../../.scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md) — add `login`/`logout`/`whoami` to the CLI's planned command set, staying in `@awthaq/cli` (not `@awthaq/client`); ship the token-based path (`--token`/`AWTHAQ_TOKEN`) now, gate the interactive device-flow path on the `DeviceAuthorization` plugin. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-session-commands`. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Fix: Add the login/logout/whoami command family to @awthaq/cli per decision 06 (token path now, device flow later). (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.

**Resolved (2026-09-29):** login/logout/whoami (packages/cli/src/Session.ts, CredentialStore.ts) per decision 06: outbound-only client of a running server over @awthaq/client's generated HttpApiClient with bearerTransformClient (a server-rotated token is persisted); login --token / AWTHAQ_TOKEN + AWTHAQ_BASE_URL is the non-interactive path, validated against GET /session and stored only when accepted; logout clears and revokes server-side best-effort; whoami exits 8 when not logged in or rejected. Proof: packages/cli/test/Session.test.ts against a real auth server on a real socket (core session group, real bearer authentication and CSRF) — no session command calls net.Server.listen. Deferred as decided: the interactive device flow needs the DeviceAuthorization plugin (P16 only specified it), so `awthaq login` without a token fails with DeviceAuthorizationUnavailable (exit 9) naming it. API-key tokens (OCM-002) are not special-cased: a bearer credential the server accepts works. Closes DAG-002 and CTA-005.
