---
ID: "TS-007"
Title: "No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO"
Level: info
Category: "architecture"
Status: needs-triage
Package: "server"
Source: "packages/server/src/Session.ts:15"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-007 — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO

`INFO` · `architecture` · `server` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **needs-triage**

## Summary

HttpServerResponse.stream / Stream-typed handlers appear nowhere under packages/ (grep across all 21 packages); the only Stream usage is in-process (AuthEvents PubSub subscriptions). All HTTP responses materialize fully in memory as Schema-decoded DTOs, which is fine for auth-sized payloads today but means large surfaces the platform supports (CSV export is even sketched in spec/behaviors/19 with `export.csv` routes) would currently buffer whole files. Honest absence, not a defect — but the contract dimension 'streaming responses' is empty by design choice, not by exhaustion.

## Evidence

Source: `packages/server/src/Session.ts:15`

```
const toDto = (item: Sessions.SessionListItem): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: item.id,
```

## Recommended fix

If the bare-router CSV/export route class (BEH-EA-152's addGuardedRoute surface) ships, add one streaming HttpServerResponse example to the server package so the buffered-response pattern doesn't get copied to payloads that should stream.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `none`. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:15`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/06-server-api.md`.
