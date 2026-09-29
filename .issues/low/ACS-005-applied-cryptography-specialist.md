---
ID: "ACS-005"
Title: "RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins"
Level: low
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Csrf.ts:55"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-005 — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins

`LOW` · `correctness` · `server` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

The platform Crypto service has no keyed MAC, so an HMAC was built from raw digests — and then copy-pasted into ChallengeStore.ts:207-228 (the copy is acknowledged in its comment), alongside three independent constantTimeEqual helpers (Sessions.ts, Csrf.ts, ChallengeStore.ts) and three toHex helpers. Both HMAC copies are textbook-correct today (pre-hash keys longer than the block, zero-pad shorter, ipad/opad), but this is security-critical code whose fixes must land in two places by memory; the same drift risk applies to the equality helpers, where Csrf's variant uses codePointAt while the others index bytes.

## Evidence

Source: `packages/server/src/Csrf.ts:55`

```
 * BEH-EA-075: HMAC-SHA256 (RFC 2104) built directly from `Crypto.digest`,
 * since the platform-neutral `Crypto` service exposes only plain digests,
 * not a keyed-MAC primitive.
```

## Recommended fix

Hoist hmacSha256, constantTimeEqual, and toHex into one internal shared module (e.g. @awthaq/ports/internal or a new @awthaq/crypto) with property tests against RFC 4231 vectors and node:crypto's timingSafeEqual as an oracle.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ACS-007` — No minimum length enforced on HMAC signing secrets](low/ACS-007-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, low)_`
- [`CDS-005` — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs](medium/CDS-005-csrf-defense-specialist.md) `_(csrf-defense-specialist, medium)_`
- [`CDS-006` — CSRF token is not bound to the session and never expires](low/CDS-006-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`MNA-008` — __Host-csrf cookie set without Secure - same prefix violation class, currently latent](low/MNA-008-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, low)_`
- [`SMS-004` — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer](medium/SMS-004-secrets-management-specialist.md) `_(secrets-management-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hmac-secret-hygiene`. Evidence at HEAD ec065a7: `packages/server/src/Csrf.ts:59`. Fix: Hoist HMAC-SHA256, constant-time equality and hex encoding into one tested module in @awthaq/ports, and use it from server, passkey and core. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/ports/src/Hmac.ts (exported as Ports.Hmac): hmacSha256, constantTimeEqualBytes/String (UTF-8 bytes, replaces Csrf's codePointAt variant), toHex, plus requireMinSecretBytes/WeakSigningSecret for ACS-007. Copies replaced in server Csrf.ts, passkey ChallengeStore.ts (touched outside my packages, tiny), core Sessions.ts and Verification.ts, password Password.ts (toHex only). Tests: packages/ports/test/Hmac.test.ts -- RFC 4231 cases 1,2 pinned to published outputs, cases 3,4,6,7 and a size-class sweep against node:crypto createHmac as oracle, constant-time helpers vs timingSafeEqual. Existing CSRF/passkey/session tests unchanged and green. Not done: fast-check property test (no fast-check dependency; used a deterministic size-class sweep instead). Verification.consume's own !== comparison is ACS-002 (another program).
