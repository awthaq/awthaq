---
ID: "AGA-003"
Title: "Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints"
Level: medium
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/Authentication.ts:288"
Auditor: "api-gateway-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AGA-003 — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints

`MEDIUM` · `architecture` · `server` · reported by **API Gateway Auth Specialist** (`api-gateway-auth-specialist`)

Status: **resolved**

## Summary

The gateway-offload path this persona exists to evaluate is asymmetric. The jwt plugin publishes a public JWKS (GET /jwt/jwks, JwtApi.ts:38) and mirrors a self-contained JWT onto every authenticated response (x-jwt-token, Jwt.ts:162), so a gateway can verify that token at the edge. But both middleware schemes resolve every credential — cookie and bearer alike — through Sessions.verify against the opaque session store, so a JWT minted at /jwt/token authenticates zero requests at the origin. There is also no RFC 7662 introspection endpoint (the only 'introspection' in the repo is the rate-limit rule registry), so opaque bearer tokens cannot be validated at a gateway either. Net: the 'terminate the session check once at the gateway' topology requires the origin hop anyway, and deployments will discover this only after building the edge-verification half. Relatedly, gateway-level role checks remain correctly out of scope — authorization stays at qadi — which is the right line even though the auth half is unrealized.

## Evidence

Source: `packages/server/src/Authentication.ts:288`

```
const bearer: typeof handle = (httpEffect, { credential }) =>
      authenticate("bearer", httpEffect, credential);
    return { cookie: handle, bearer };
```

## Recommended fix

Document the credential contract explicitly on the jwt plugin surface (minted tokens are for downstream verifiers via jwt/verify.ts, never accepted by the issuing origin). Then close the gap in one of two directions: an introspection endpoint for opaque bearer tokens, or an opt-in JWT-validation scheme in the middleware with its own audience value so edge-verified requests can be accepted (with the gateway-origin trust channel — mTLS or network policy — stated as a requirement).

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Gateway deployment posture
- Full dossier: [`api-gateway-auth-specialist`](../../.reports/api-gateway-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AGA-006` — No trusted-header identity seam exists — correctly so for this architecture](info/AGA-006-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, info)_`
- [`CTA-006` — Token rotation reaches native clients only as a response header no client captures](medium/CTA-006-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`
- [`ECF-005` — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper](low/ECF-005-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-003` — Authentication middleware maps PlatformError (backend outage) into 401 Unauthenticated](medium/EEM-003-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ELC-007` — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement](low/ELC-007-effect-layer-context-architect.md) `_(effect-layer-context-architect, low)_`
- [`EOTS-003` — Failed authentication attempts are completely unobservable](high/EOTS-003-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`JR-004` — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only](medium/JR-004-justin-richer.md) `_(justin-richer, medium)_`
- [`MAPS-001` — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens](high/MAPS-001-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, high)_`
- … 9 more findings touch `packages/server/src/Authentication.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bearer-credential-extensibility`. Duplicate of `MAPS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:299`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
