---
ID: "IC-007"
Title: "Fixed non-configurable __Host-/Strict cookie forecloses legitimate deployments"
Level: low
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:122"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-007 — Fixed non-configurable __Host-/Strict cookie forecloses legitimate deployments

`LOW` · `architecture` · `core` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

Secure-by-default with zero footguns is the right default, and I would not relax it for a v1. But the attributes are a compile-time constant used at every issuance site, so deployments with real constraints — session shared across app.example.com and api.example.com (needs a Domain cookie, incompatible with __Host-), TLS terminated at a proxy in front of an internal HTTP hop, or preview environments — have no escape hatch at all, whereas Auth.js exposes cookie prefix/secure/sameSite configuration precisely for these. The bearer scheme (Api.ts:117-119) partially covers non-browser clients but not a browser app spanning subdomains.

## Evidence

Source: `packages/core/src/Sessions.ts:122`

```
/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
```

## Recommended fix

Keep __Host-/strict as the hard default, but allow an explicit, documented downgrade (e.g. a SessionCookieConfig Reference selecting __Secure- + domain) so constrained deployments are served without weakening anyone else's default.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-cookie-policy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:151`. Fix: Introduce SessionCookieConfig with a secure default and typed opt-in modes (incl. __Secure-+Domain for multi-subdomain apps); route every issuance site through one helper. (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan (SessionCookieConfig with typed modes Host/HostEmbedded/SecureDomain + persistence absolute|browserSession); user may revisit. New packages/core/src/SessionCookie.ts (exported as core SessionCookie): closed Mode union (only SecureDomain carries a domain and renders __Secure-session, so __Host- + Domain is unrepresentable), SessionCookieConfig Context.Reference (default = today's attribute set + Max-Age), pure renderAt, effectful render/set/expire, cookieName, csrfCookieOptions. Sessions.SESSION_COOKIE_ATTRIBUTES removed: every issuance site now renders through the helper -- password x3, passkey, admin (SessionCookie.set), oauth (render on the redirect), server rotationDelivery (render + Max-Age recomputed from the refreshed session), server expire helper, Next applyRotatedSession (default config, renderAt). Readers use the configured name: Authentication cookie handler (both middlewares), qadi SubjectExtractor, migrate-better-auth alias middleware; Next reads/renders under the default config only (documented). WithNextCookies CookieSetOptions gained partitioned. Tests: core/test/SessionCookie.test.ts (default byte-for-byte + Max-Age from absoluteExpiresAt, shrink/never negative, browserSession, HostEmbedded, SecureDomain, names, csrf options); server Authentication.test.ts (rotated Max-Age recomputed, HostEmbedded rotation, SecureDomain read/rotate); password AuthHttp wire test (default attributes + ~30d Max-Age). Spec BEH-EA-055 rewritten as secure default + typed modes (title kept: anchors). Deferred: CSRF cookie stays host-only under SecureDomain; Next cannot read a custom config (no Effect context). Touches password/passkey/oauth/admin/next/qadi/migrate-better-auth sources.
