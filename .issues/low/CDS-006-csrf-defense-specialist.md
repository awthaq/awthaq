---
ID: "CDS-006"
Title: "CSRF token is not bound to the session and never expires"
Level: low
Category: "security"
Status: resolved
Package: "server"
Source: "packages/server/src/Csrf.ts:95"
Auditor: "csrf-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CDS-006 — CSRF token is not bound to the session and never expires

`LOW` · `security` · `server` · reported by **CSRF Defense Specialist** (`csrf-defense-specialist`)

Status: **resolved**

## Summary

The minted token is pure randomness signed by the static secret (mint, Csrf.ts:91-98) — no issued-at, no expiry, no binding to the session or principal. Any validly signed value remains acceptable until the secret rotates, and the cookie (no maxAge → browser-session lifetime) rotates only when absent or signature-invalid. For a double-submit design this is a recognized tradeoff, but fixation resistance then rests entirely on __Host- host-only scoping: there is no second mechanism that would invalidate a token leaked or fixated before a session existed. The signature is a correct constant-time comparison (Csrf.ts:38-43,100-111), so this is hardening, not a break.

## Evidence

Source: `packages/server/src/Csrf.ts:95`

```
const token = toHex(yield* crypto.randomBytes(32));
```

## Recommended fix

Sign <iat>.<random> and reject tokens older than a bounded window (e.g. 24h); optionally rotate the CSRF cookie whenever Authentication issues or supersedes a session — the next package's spec already anticipates CSRF rotation through withNextCookies.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: CSRF defense
- Full dossier: [`csrf-defense-specialist`](../../.reports/csrf-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-005` — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins](low/ACS-005-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`ACS-007` — No minimum length enforced on HMAC signing secrets](low/ACS-007-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`CDS-005` — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs](medium/CDS-005-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`MNA-008` — __Host-csrf cookie set without Secure - same prefix violation class, currently latent](low/MNA-008-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, low)_`
- [`SMS-004` — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer](medium/SMS-004-secrets-management-specialist.md) `_(secrets-management-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `csrf-hardening`. Evidence at HEAD ec065a7: `packages/server/src/Csrf.ts:91`. Fix: Time-bound the double-submit token: sign `<iat>.<random>`, reject tokens older than a configurable max age, and re-mint proactively so the window never bites mid-session. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Csrf.ts: token is now <iatSeconds>.<random>.<hmac(iat.random)> (HMAC covers iat), valid while now - iat <= CsrfConfig.maxAge (new optional field, default 24h; iat more than 60s in the future rejected), re-minted on any safe or unsafe request once a valid token is older than maxAge/2; a token past maxAge is invalid (403 on unsafe, fresh cookie on that response). Deliberately not session-bound (documented in the file header and BEH-EA-075: rotation every touchEvery would 403 hourly). Tests (server/test/Csrf.test.ts, TestClock): older than maxAge rejected on POST, within maxAge accepted past half-life, tampered iat fails signature, future iat rejected, re-minted at half-life on a GET (fresh iat), not re-minted when fresh. CROSS-BRANCH HAZARD: the wire format changed, so every hand-built double-submit cookie in tests had to move to the new format (server, password, passkey, admin, organization AuthHttp tests and features/step-definitions/CsrfTestSupport.ts; iat 0 under TestClock, real seconds for web-handler tests). Any test another branch adds with the old '<token>.<hmac>' helper will 403 after merge -- this is landed as its own separable commit.
