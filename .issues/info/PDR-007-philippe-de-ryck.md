---
ID: "PDR-007"
Title: "Spec mandates CSRF composition (BEH-EA-073..080 MUSTs) while shipped contracts cannot satisfy it"
Level: info
Category: "compliance"
Status: resolved
Package: "api"
Source: "packages/api/src/Api.ts:106"
Auditor: "philippe-de-ryck"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PDR-007 — Spec mandates CSRF composition (BEH-EA-073..080 MUSTs) while shipped contracts cannot satisfy it

`INFO` · `compliance` · `api` · reported by **Philippe De Ryck — Web Application Security Trainer** (`philippe-de-ryck`)

Status: **resolved**

## Summary

The contract stratum fixes the CSRF wire names ('__Host-csrf'/'x-csrf-token', never per-plugin configurable), declares the middleware with requiredForClient: true, and spec 10-csrf.md phrases every layer as a REQUIREMENT/MUST — the traceability story a security reviewer is told is that these behaviors are effective. The code ground truth is that the names are reserved and both halves implemented, but no shipped contract exercises them, so the specified wire behavior (minted cookie on first visit, echoed header on unsafe methods) never appears on any real endpoint. Documented as info rather than a second security finding because PDR-002 carries the risk; this records the docs-vs-code divergence the audit method requires cross-checking.

## Evidence

Source: `packages/api/src/Api.ts:106`

```
export const CSRF_COOKIE_NAME = "__Host-csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";
```

## Recommended fix

Either land the attachments (closing PDR-002) or mark BEH-EA-073..080 as implemented-not-wired in the spec/traceability layer, so downstream consumers of the spec do not assume the composed check is live on current contracts.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Web attack surface
- Full dossier: [`philippe-de-ryck`](../../.reports/philippe-de-ryck/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`MAPS-004` — Auth scheme chain is a closed two-key record - no seam for new credentials](medium/MAPS-004-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `csrf-hardening`. Already fixed by commit 409334e. Evidence at HEAD ec065a7: `packages/api/src/Session.ts:59`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
