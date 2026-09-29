---
ID: "MAPS-004"
Title: "Auth scheme chain is a closed two-key record - no seam for new credentials"
Level: medium
Category: "architecture"
Status: ready-for-human
Package: "api"
Source: "packages/api/src/Api.ts:118"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-004 — Auth scheme chain is a closed two-key record - no seam for new credentials

`MEDIUM` · `architecture` · `api` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **ready-for-human**

## Summary

The comment at Api.ts:111-112 says 'the record's own key order is the entire strategy chain', and that record is a fixed structural type { cookie, bearer } hardcoded in both Authentication and OptionalAuthentication declarations and in both server-side Layer implementations. spec/models/07-api-keys.md:70-71 assumes an API key 'would be a third scheme tried in declaration order, not a parallel authentication system' - but no extension point exists: adding any scheme requires editing @awthaq/api and @awthaq/server, i.e. forking the framework. This is the single structural blocker that keeps MAPS-001/003 from being plugin work.

## Evidence

Source: `packages/api/src/Api.ts:118`

```
security: { cookie: SessionCookie, bearer: BearerToken },
```

## Recommended fix

Introduce a declarative, ordered scheme registry (e.g. a Slot-style Context.Reference a plugin can contribute an entry to, in the same spirit as HookPoint/Slots) that AuthenticationLive folds into its security handling, keeping cookie-first ordering as the built-in default.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-009` — Session cookie name duplicated as literals across the api/core stratum boundary](low/BE-009-bereket-engida.md) `_(bereket-engida, low)_`
- [`CSS-007` — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'](low/CSS-007-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`EHA-006` — OptionalAuthentication advertises a 401 that its implementation can never produce](low/EHA-006-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`EHA-008` — Security-critical cookie name duplicated as independent literals between api and core](low/EHA-008-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`JR-007` — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere](low/JR-007-justin-richer.md) `_(justin-richer, low)_`
- [`MW-009` — Cookie/CSRF names duplicated across strata by construction, not by convention](low/MW-009-matias-woloski.md) `_(matias-woloski, low)_`
- [`NHS-010` — Auth strategy order is encoded as security-record key order in two synced places](low/NHS-010-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`OCM-003` — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable](medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`
- … 2 more findings touch `packages/api/src/Api.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bearer-credential-extensibility`. Evidence at HEAD ec065a7: `packages/api/src/Api.ts:110`. Fix: Generalize decision 33's single BearerCredentialResolver into an ordered, plugin-contributed registry of bearer resolvers, so jwt and api-key (and later SCIM) can each claim bearer credentials without editing @awthaq/api or @awthaq/server. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-human.
