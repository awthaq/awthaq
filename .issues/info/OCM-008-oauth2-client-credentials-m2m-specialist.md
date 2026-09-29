---
ID: "OCM-008"
Title: "Spec and code agree on non-implementation — docs claim verified against code"
Level: info
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/models/07-api-keys.md:23"
Auditor: "oauth2-client-credentials-m2m-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OCM-008 — Spec and code agree on non-implementation — docs claim verified against code

`INFO` · `docs` · `—` · reported by **OAuth2 Client Credentials / M2M Specialist** (`oauth2-client-credentials-m2m-specialist`)

Status: **ready-for-agent**

## Summary

Cross-checking the docs claim required by the audit method: the spec's own 'What is missing' section (lines 99-108) says 'Everything: no contract, no ApiKeyPrincipal case in a CurrentPrincipal union that does not yet exist, no hashing/storage implementation, no SubjectResolver wiring, no test', and the code confirms each point — the union exists but ref-only, the package is empty, and the only ApiKey test in packages/test asserts id-only resolution precisely because no scopes source exists. The design intent (hash-at-rest, show-once, scoped, explicit principal kind, mirroring Stripe/WorkOS/Clerk/better-auth) is sound and production-informed.

## Evidence

Source: `spec/models/07-api-keys.md:23`

```
Nothing described here exists yet — awthaq is pre-implementation.
```

## Recommended fix

None required for honesty; when M7 lands, update the model doc's Status table and adopt its recommended key format explicitly rather than leaving 'recommended, not adopted' in place.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: M2M authentication
- Full dossier: [`oauth2-client-credentials-m2m-specialist`](../../.reports/oauth2-client-credentials-m2m-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`OCM-005` — Rotation-with-grace-window and transport for client secrets are explicitly undecided](medium/OCM-005-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `spec-status-banner-sweep`. Evidence at HEAD ec065a7: `packages/api-key/src/index.ts:8`. Fix: Positive finding is correct about the plugin, but 07-api-keys.md carries two stale sentences; fix them in the banner sweep. (Rotation/transport decisions are OCM-005's, not this ID's.) (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
