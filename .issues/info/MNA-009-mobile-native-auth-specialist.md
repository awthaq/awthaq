---
ID: "MNA-009"
Title: "Docs promise a native bearer path the code does not finish"
Level: info
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/09-authentication-middleware.md:55"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-009 — Docs promise a native bearer path the code does not finish

`INFO` · `docs` · `—` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **ready-for-agent**

## Summary

The resolution half of this docs claim is real (bearer handler in AuthenticationLive), but the other halves are not: the { csrf: false } client contract variant is admitted unimplemented (@awthaq/client/src/AuthClient.ts:27-35), the token acquisition leg does not exist (MNA-001), and magic-link - the flow mobile users most often need - is an empty export-{} placeholder (packages/magic-link/src/index.ts:8-10). A mobile developer reading the specs would expect a working path and hit a wall at the first sign-in call.

## Evidence

Source: `spec/behaviors/09-authentication-middleware.md:55`

```
`archive/design/usage-examples-v4.md` §11.3 documents the native-client path this handler serves: a mobile or CLI client with no cookie jar reaches the same contract via `Auth.api(..., { csrf: false })` and a bearer token pulled from a keychain, and is expected to be resolved to the same `Principal` shape a browser session would be.
```

## Recommended fix

Mark the native path explicitly as resolution-only in the behavior docs until issuance, rotation handling, and a mobile-friendly sign-in flow exist.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CTA-004` — Credential storage is an open question — no keychain integration, no fallback decision, no prohibition](medium/CTA-004-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `native-bearer-bootstrap`. Evidence at HEAD ec065a7: `spec/behaviors/09-authentication-middleware.md:55`. Fix: Doc-side only here: amend BEH-EA-066's native-client paragraph to state what exists (bearer resolution + `set-auth-token` rotation header) and what doesn't (token issuance → MNA-001 per decision ticket 17; `{ csrf: false }` variant → BEH-EA-171; magic-link unimplemented). Rewrite it again as a positive statement when MNA-001 lands. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
