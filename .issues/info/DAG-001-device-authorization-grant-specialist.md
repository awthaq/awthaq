---
ID: "DAG-001"
Title: "RFC 8628 device authorization grant is entirely unimplemented and deferred to Phase 3"
Level: info
Category: "compliance"
Status: resolved
Package: "—"
Source: "archive/PRD.md:279"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-001 — RFC 8628 device authorization grant is entirely unimplemented and deferred to Phase 3

`INFO` · `compliance` · `—` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **resolved**

## Summary

No device authorization code exists anywhere under packages/: zero references to device_code, user_code, verification_uri, slow_down, or a DeviceAuthorization plugin. The PRD assigns the plugin to Phase 3, and the model doc confirms no contract, no worked example, and no test. For an input-constrained client (CLI, TV, IoT), awthaq currently offers no standards-based cross-device login path; the only session-issuing methods are the browser-oriented plugins.

## Evidence

Source: `archive/PRD.md:279`

```
| 3 | `Sso`, `Saml`, `OidcProvider`, `Scim`, `DeviceAuthorization` |
```

## Recommended fix

Keep the deferral, but before Phase 3 begins promote the corpus design into a normative BEH-EA behavior range and spec/invariants entries so the endpoint pair, state machine, and abuse controls are specified before code.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `device-authorization-grant`. Duplicate of `DAG-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/roadmap.md:125`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `DAG-005-device-authorization-grant-specialist` — closed by its fix (see that issue's Resolved comment).
