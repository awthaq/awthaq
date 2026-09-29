---
ID: "TMS-003"
Title: "Open redirect: resolveCallbackURL accepts any '/'-prefixed value before the origin allowlist, including protocol-relative URLs"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:156"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-003 — Open redirect: resolveCallbackURL accepts any '/'-prefixed value before the origin allowlist, including protocol-relative URLs

`MEDIUM` · `security` · `oauth` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

The trustedOrigins allowlist only ever runs on values that fail the startsWith('/') check, so callbackURL=//evil.com (or /\evil.com) is stored verbatim in the encrypted flow payload at authorize time and later emitted as the post-authentication redirect target (OAuth.ts:335, Location: //evil.com), which browsers resolve against the current origin's scheme and navigate to the attacker host. An attacker crafts an authorize link with such a callbackURL; a victim completing the flow lands straight from 'logged in' onto attacker-controlled infrastructure — a credential-harvesting/phishing pivot on the OAuth boundary. No code or token travels in the redirect, which is why this is not high, but it defeats the entire purpose of BEH-EA-128's allowlist.

## Evidence

Source: `packages/oauth/src/OAuth.ts:156`

```
  if (raw === undefined) return fallback;
  if (raw.startsWith("/")) return raw;
  const parsed = Option.fromNullOr(URL.parse(raw));
```

## Recommended fix

Reject values whose first non-'/' character is another '/' or '\\' (or parse same-origin candidates and compare new URL(raw, baseUrl).origin against the app origin) before treating a relative path as safe.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `oauth-callback-url-policy`. Already fixed by commit 9b3e42c. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:180`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
