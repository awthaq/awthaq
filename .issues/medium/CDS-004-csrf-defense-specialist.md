---
ID: "CDS-004"
Title: "No-payload mutating POSTs bypass the JSON content-type gate — SameSite-only defense for logout and kill-switch endpoints"
Level: medium
Category: "security"
Status: resolved
Package: "api"
Source: "packages/api/src/Session.ts:45"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-004 — No-payload mutating POSTs bypass the JSON content-type gate — SameSite-only defense for logout and kill-switch endpoints

`MEDIUM` · `security` · `api` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

signOut, revokeOthers, and revokeAll (Session.ts:45,52,58) declare no payload schema, and the framework skips payload decoding entirely for such endpoints (`shouldParsePayload = endpoint.payload.size > 0 && !isRaw`, HttpApiBuilder.ts:826) — so the 415 content-type check never runs for them. A cross-site top-level form POST (urlencoded, text/plain, or multipart — any content-type) reaches these handlers directly. The only thing that fails the forgery is the browser refusing to SEND __Host-session cross-site (SameSite=Strict); a browser or WebView without SameSite enforcement, or a same-site attacker page (Strict cookies are sent same-site), completes forged logouts and full session revocations for the victim. Logout CSRF is also a session-integrity denial-of-service, not just a nuisance.

## Evidence

Source: `packages/api/src/Session.ts:45`

```
.add(HttpApiEndpoint.post("signOut", "/session/sign-out"))
```

## Recommended fix

Attach CsrfProtection to the core session group (CDS-001) — the double-submit leg rejects forgeries regardless of SameSite support and regardless of payload shape, because the forged request cannot echo a host-only cookie value it cannot read.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EHA-004` — Core session/account groups never composed: Auth.make's served api has no session endpoints](medium/EHA-004-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`MW-008` — SessionDto date fields typed as unconstrained Schema.String — format is convention, not contract](low/MW-008-matias-woloski.md) `_(matias-woloski, low)_`
- [`SMS-005` — signOut/revokeAll never clear the session cookie from the browser](low/SMS-005-session-management-specialist.md) `_(session-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `csrf-hardening`. Already fixed by commit 409334e. Evidence at HEAD ec065a7: `packages/api/src/Session.ts:59`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
