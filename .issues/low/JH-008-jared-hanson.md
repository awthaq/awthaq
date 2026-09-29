---
ID: "JH-008"
Title: "Ports-never-provided sandboxing rule is convention, not an enforced boundary"
Level: low
Category: "architecture"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:174"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-008 — Ports-never-provided sandboxing rule is convention, not an enforced boundary

`LOW` · `architecture` · `jwt` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **ready-for-agent**

## Summary

ADR-EA-010's guarantee that two plugins cannot both provide one port "by construction" holds only for the AuthPlugin.layer helper's declared ROut (Self | ToService). The Jwt pattern — merging arbitrary extra layers into a plugin's static layer via Layer.provideMerge, already blessed as "first plugin in this codebase to merge a second Layer" (Jwt.ts:142-145) — is a general escape hatch: any plugin can contribute any service, including a port implementation, and nothing at type or runtime level distinguishes a legitimate seam override (PostAuthResponseHook) from a smuggled PasswordHasher. The capability model is namespaced where it counts (contract groups, rate-limit scope checks) but porous at the layer boundary; ADR-EA-010's own text concedes enforcement is deferred.

## Evidence

Source: `packages/jwt/src/Jwt.ts:174`

```
  static readonly layer = Layer.provideMerge(
    PostAuthResponseHookLive,
    AuthPlugin.layer(Jwt, {
```

## Recommended fix

Keep the escape hatch but make it declarative: extend AuthPlugin.layer options with an explicit `provides: Layer [...]` whose members are checked at composition time against a reserved-ports deny list (ports packages' tags), so Auth.make fails with a typed PortsProvidedByPlugin error instead of the rule living in an ADR.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `plugin-port-boundary-enforcement`. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:313`. Fix: Enforce BEH-EA-020 at the type level: `Auth.make`'s `Validate<P>` rejects any plugin whose layer's ROut contains a port tag. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.
