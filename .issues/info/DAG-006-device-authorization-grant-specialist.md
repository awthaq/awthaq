---
ID: "DAG-006"
Title: "Session-issuance integration point is well-prepared for a future device flow"
Level: info
Category: "architecture"
Status: needs-triage
Package: "—"
Source: "spec/models/13-device-authorization.md:44"
Auditor: "device-authorization-grant-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DAG-006 — Session-issuance integration point is well-prepared for a future device flow

`INFO` · `architecture` · `—` · reported by **Device Authorization Grant Specialist** (`device-authorization-grant-specialist`)

Status: **needs-triage**

## Summary

The planned plugin consumes the same Sessions/Users services as every other login method, which is the correct shape: a device-flow approval must mint an ordinary session (with request ip/userAgent metadata — Sessions.issue already carries both, feeding BEH-EA-054's device list/revoke UX) rather than inventing a bespoke token type. The RateLimiter port and its pluggable store give the abuse controls a home without new capability plumbing. This readiness is why the deferred domain can be added purely additively, as the model doc's Breaking? row claims.

## Evidence

Source: `spec/models/13-device-authorization.md:44`

```
dependsOn: [Sessions, Users],
```

## Recommended fix

Preserve this when implementing: the /device/token poll must call Sessions.issue on the claimed userId (thereby inheriting revocation, device listing, and idle/absolute expiry invariants), never a parallel credential path.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 34/100), domain: Device Authorization Grant
- Full dossier: [`device-authorization-grant-specialist`](../../.reports/device-authorization-grant-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DAG-004` — No user-code entropy/format or rate-limit design exists for the verification surface](medium/DAG-004-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, medium)_`
- [`DAG-007` — Zero test or BDD coverage allocated to the device domain](medium/DAG-007-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `device-authorization-design`. Evidence at HEAD ec065a7: `spec/models/13-device-authorization.md:44`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/12-spec.md`.
