---
ID: "CSS-004"
Title: "Wire tests assert cookie names only and discard attributes — the class of bug in CSS-001 is invisible to the suite"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/test/AuthHttp.test.ts:169"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-004 — Wire tests assert cookie names only and discard attributes — the class of bug in CSS-001 is invisible to the suite

`MEDIUM` · `testing` · `oauth` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **ready-for-agent**

## Summary

The OAuth wire tests regex only the cookie's name; the shared cookieFrom helper in every plugin suite (e.g. packages/password/test/AuthHttp.test.ts:137-141) does raw.split(";")[0], deliberately throwing the attribute half away. So nothing verifies Secure/HttpOnly/SameSite/Path/no-Domain for the oauth-state or the plugin-issued session cookies at wire level — path:"/oauth" passed CI precisely because of this. The BDD suite shows the right pattern: SessionSteps.ts:146-161 asserts Secure, HttpOnly, SameSite=Strict, Path=/ and the absence of Domain against the raw Set-Cookie header for the session cookie, but no equivalent exists for the other two cookies.

## Evidence

Source: `packages/oauth/test/AuthHttp.test.ts:169`

```
const cookie = response.headers.get("set-cookie");
        assert.isString(cookie);
        assert.match(cookie ?? "", /^__Host-oauth-state=/);
```

## Recommended fix

Replace the name-only regex with an attribute-asserting helper (or a tiny RFC 6265bis prefix-validating cookie jar in the web-handler tests) and apply it to the oauth-state, session, and csrf Set-Cookie headers alike.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 58/100), domain: Cookie & Set-Cookie security
- Full dossier: [`cookie-security-specialist`](../../.reports/cookie-security-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-callback-http-hardening`. Evidence at HEAD ec065a7: `packages/oauth/test/AuthHttp.test.ts:183`. Fix: Add a shared Set-Cookie attribute assertion helper and apply it to every OAuth-emitted cookie. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
