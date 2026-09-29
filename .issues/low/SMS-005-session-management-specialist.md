---
ID: "SMS-005"
Title: "signOut/revokeAll never clear the session cookie from the browser"
Level: low
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/src/Session.ts:56"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-005 — signOut/revokeAll never clear the session cookie from the browser

`LOW` · `api` · `api` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

The endpoints delete the server-side row — correct and authoritative — but deliberately set no cookie-clearing response, so the stale __Host-session value persists in the browser's jar until the browser closes (the cookie carries no Max-Age). Subsequent requests keep shipping the dead token, every one of which fails verification with Unauthenticated; on a shared machine the token also lingers in cookie stores and any request logs capture a now-dead but real secret. Standard hygiene is an overwrite Set-Cookie with an empty value and Max-Age=0.

## Evidence

Source: `packages/api/src/Session.ts:56`

```
// session. No payload, no response cookie-clearing, matching
  // `signOut`'s existing precedent.
```

## Recommended fix

In the signOut and revokeAll handlers (and revoke when the target is the current session), append HttpServerResponse.setCookie with SESSION_COOKIE_NAME, empty value, and the fixed attributes plus maxAge: 0.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CDS-004` — No-payload mutating POSTs bypass the JSON content-type gate — SameSite-only defense for logout and kill-switch endpoints](medium/CDS-004-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`EHA-004` — Core session/account groups never composed: Auth.make's served api has no session endpoints](medium/EHA-004-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`MW-008` — SessionDto date fields typed as unconstrained Schema.String — format is convention, not contract](low/MW-008-matias-woloski.md) `_(matias-woloski, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-cookie-expiry`. Duplicate of `CSS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/api/src/Session.ts:53`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
