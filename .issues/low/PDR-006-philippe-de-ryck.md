---
ID: "PDR-006"
Title: "CallbackURL validation tests never exercise protocol-relative or backslash variants"
Level: low
Category: "testing"
Status: resolved
Package: "oauth"
Source: "packages/oauth/test/OAuth.test.ts:756"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-006 — CallbackURL validation tests never exercise protocol-relative or backslash variants

`LOW` · `testing` · `oauth` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **resolved**

## Summary

The BEH-EA-128 describe block covers exactly three shapes: allowlisted absolute honored (REQ-EA-352), untrusted absolute fallen back (REQ-EA-353), and a plain relative /settings honored 'safe by construction'. The third test enshrines the wrong assumption: the // and /\ prefixes that browsers resolve as cross-origin are never asserted, so PDR-001's bypass ships with a green suite and a test comment that actively states the unsafe invariant. This is the test-for-each-pitfall discipline my rubric calls for: the open-redirect class is the single most abused OAuth implementation bug, and it has no regression case.

## Evidence

Source: `packages/oauth/test/OAuth.test.ts:756`

```
it.effect("a relative callbackURL is always honored (same-origin, safe by construction)", () =>
```

## Recommended fix

Add failing-today cases to the REQ-EA-353 block: callbackURL //evil.example.com and /\\evil.example.com must resolve to the fallback ("/"), alongside a javascript: URL (which the origin check already rejects) so the suite pins the whole class, not just the absolute-URL instance.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Web attack surface
- Full dossier: [`philippe-de-ryck`](../../.reports/philippe-de-ryck/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OIT-009` — id_token test suite omits alg confusion, kid rotation, azp/array-aud, and userinfo sub mismatch](low/OIT-009-oidc-id-token-specialist.md) `_(oidc-id-token-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `oauth-callback-url-policy`. Already fixed by commit 9b3e42c. Evidence at HEAD ec065a7: `packages/oauth/test/OAuth.test.ts:802`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
