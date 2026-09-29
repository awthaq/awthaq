---
ID: "AGA-004"
Title: "No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate"
Level: medium
Category: "security"
Status: ready-for-human
Package: "core"
Source: "packages/core/src/Sessions.ts:124"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-004 — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate

`MEDIUM` · `security` · `core` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **ready-for-human**

## Summary

All three cookie issuance sites — the session cookie (fixed attributes at Sessions.ts:124-129: secure, httpOnly, SameSite=Strict, Path=/), the OAuth state cookie (OAuth.ts:308-314), and the CSRF cookie (Csrf.ts:155-159) — omit the Partitioned attribute, and a repo-wide grep finds no use of it. SameSite=Strict additionally excludes third-party contexts outright. Consequence: any embedded scenario (the auth widget in a partner iframe, a SaaS app embedded in a portal) silently fails to authenticate on browsers restricting third-party cookies — precisely the CHIPS regime now default in Chrome and Safari. STACK.md:77 notes the underlying Effect cookie model already supports 'the full modern attribute set (including CHIPS Partitioned)', so the capability exists one layer down and is simply unused. The fixed non-configurable attribute set is defensible for the default topology, but there is no opt-in path for the embedded one.

## Evidence

Source: `packages/core/src/Sessions.ts:124`

```
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
```

## Recommended fix

Add an opt-in embedded mode that issues the session (and CSRF) cookie as Secure; SameSite=None; Partitioned for deployments served inside third-party iframes, keeping the current __Host-/Strict default for standard deployments — and document that embedded mode trades the __Host- prefix and Strict containment for partitioned-jar isolation.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Gateway deployment posture
- Full dossier: [`api-gateway-auth-specialist`](../../.reports/api-gateway-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-cookie-policy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:151`. Fix: Deliver the `HostEmbedded` mode of IC-007's SessionCookieConfig (SameSite=None; Partitioned; __Host- kept) for session and CSRF cookies. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-human.
