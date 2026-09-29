---
ID: "JR-004"
Title: "Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only"
Level: medium
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:172"
Auditor: "justin-richer"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JR-004 — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only

`MEDIUM` · `architecture` · `server` · reported by **Justin Richer — OAuth2/OIDC Contributor, Co-author of "OAuth 2 in Action"** (`justin-richer`)

Status: **resolved**

## Summary

Token semantics by role: the auth-server role issues opaque revocable sessions AND self-contained JWTs (Jwt plugin: /jwt/token mint, JWKS endpoint, x-jwt-token response mirroring with iss/aud/sid/act claims), while the resource-server role for those JWTs lives exclusively downstream in jwt/verify.ts. The server's own Authentication middleware resolves every credential — cookie and bearer alike — through Sessions.verify, so a JWT minted at /jwt/token authenticates zero requests against the issuing server that minted it. This is a deliberate, spec-backed split (spec/models/08-jwt-bearer.md: JWT is 'for handing an authenticated caller's identity to a downstream service'; BEH-EA-066: bearer = session token for cookie-less native clients), and it cleanly avoids the two-token-systems trap — but nothing on the Jwt plugin's contract or README tells an operator that the minted token is unusable against the issuing API, and the x-jwt-token mirroring hands every authenticated browser response a credential that looks like an API credential but is not one.

## Evidence

Source: `packages/server/src/Authentication.ts:172`

```
? Effect.fail(new Api.Unauthenticated())
        : sessions
            .verify(Redacted.make(raw))
```

## Recommended fix

Document the audience contract on the Jwt plugin surface (minted tokens are for downstream verifiers via jwt/verify.ts, never for the issuing API). Optionally offer an opt-in JWT-validation scheme in the middleware for deployments that want the issuing server to double as a resource server, with its own audience value.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth protocol semantics
- Full dossier: [`justin-richer`](../../.reports/justin-richer/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-003` — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints](medium/AGA-003-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bearer-credential-extensibility`. Duplicate of `MAPS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:184`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MAPS-001-microservices-auth-propagation-specialist` — closed by its fix (see that issue's Resolved comment).
