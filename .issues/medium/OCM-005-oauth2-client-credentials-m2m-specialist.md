---
ID: "OCM-005"
Title: "Rotation-with-grace-window and transport for client secrets are explicitly undecided"
Level: medium
Category: "compliance"
Status: resolved
Package: "—"
Source: "spec/models/07-api-keys.md:106"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-005 — Rotation-with-grace-window and transport for client secrets are explicitly undecided

`MEDIUM` · `compliance` · `—` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **resolved**

## Summary

Zero-downtime rotation — two simultaneously valid secrets with a bounded window — is the load-bearing design decision for M2M credentials, and the spec leaves it open alongside the transport header. Nothing in code forces an answer before M7, so the risk is an implementation that hard-cuts secrets (outage on rotation) or accepts both forever (no window bound). The repo already demonstrates the right discipline one layer up: KeyRing keeps a current signing key plus every still-verifiable key through a 30-day grace period (JwtConfig.ts:47-48), and KeyProvider.ts:22-24 explicitly notes multi-key rotation is a future property of that interface.

## Evidence

Source: `spec/models/07-api-keys.md:106`

```
human-readable `start` prefix for list UX, rotation-with-grace-window
behavior, and whether the transport is `x-api-key`, `Authorization: Bearer`,
or both.
```

## Recommended fix

Decide before implementation: dual-secret create (new key becomes primary, old key stays verifiable until a fixed grace window — mirroring the 30-day keyGracePeriod default), and pin the transport to x-api-key (bearer is reserved for short-lived tokens) so strategies do not double-try one credential format.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OCM-008` — Spec and code agree on non-implementation — docs claim verified against code](info/OCM-008-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `m2m-client-secret-lifecycle`. Evidence at HEAD ec065a7: `spec/models/07-api-keys.md:106`. Fix: Decide and record (ADR-EA-022) API-key and client-secret rotation with a bounded dual-validity grace window and the transport header, then carry it into the api-key build (OCM-002, cross-slice). (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan; user may revisit: dual-validity rotation with a configurable bounded grace (default 24h, max 30d), x-api-key transport only for API keys, Bearer reserved for JWTs. Recorded as spec/decisions/022-api-key-rotation-and-transport.md (ADR-EA-022; decisions/index.yaml + spec/traceability.md row); spec/models/07-api-keys.md moved rotation/transport out of the undecided list. Code: ApiKey.rotate(owner, keyId, {gracePeriod, expiresIn}) mints a successor (rotatedFrom) and shortens the predecessor's expiry to now+grace (never lengthens), publishes auth.apiKey.rotated; rotateClientSecret keeps at most two valid secret hashes. Configurable header name not built (the contract's HttpApiSecurity key is static) — documented as a limit. Test: packages/api-key/test/ApiKey.test.ts 'after rotate both keys resolve until the grace window elapses (TestClock), then only the successor' (memory + sql) and ServiceToken.test.ts secret rotation.
