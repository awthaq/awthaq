---
ID: "GC-003"
Title: "Brand re-entry into the domain is by unchecked nominal casts in the imperative shell"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Session.ts:62"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-003 — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell

`MEDIUM` · `architecture` · `server` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **ready-for-agent**

## Summary

`Brand.nominal` is documented in effect as applying no runtime checks, so every `UserId(...)`/`SessionId(...)` call in the server handlers (Session.ts:62-63, 74-75, 100-101, 113, 122) is an assertion that a plain wire string is a well-formed domain id — repeated at six-plus call sites instead of being made once at the decode boundary. The wire DTOs deliberately use unbranded `Schema.String` (api/Api.ts PrincipalRef, api/Session.ts SessionDto), which is principled, but the consequence is that the compile-time-only brand is re-established by hand everywhere the shell calls back into the core, and one new handler forgetting the cast compiles fine with `string` flowing where `UserId` is required... only to fail elsewhere. The same pattern exists in the SQL bridges (`UserId(row.id)` in Users.ts:197) and one redundant assertion at Sessions.ts:228 (`input.supersedes as SessionId`, already narrowed).

## Evidence

Source: `packages/server/src/Session.ts:62`

```
        const userId = Users.UserId(principal.ref.id);
```

## Recommended fix

Brand at the decode boundary instead: declare the DTO id fields as `Schema.String.pipe(Schema.brand("UserId"))/brand("SessionId")` so HttpApi decoding yields branded values directly, and reserve `Brand.nominal` for the single minting site (randomUUIDv7); delete the redundant `as SessionId`.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-handler-hardening`. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:33`. Fix: Re-establish brands once per request in one shared helper, not at 12 call sites, and delete the duplicated currentUserPrincipal. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
