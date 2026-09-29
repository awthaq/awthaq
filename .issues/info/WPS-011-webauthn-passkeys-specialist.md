---
ID: "WPS-011"
Title: "Package quality metrics and behavior-spec banner still describe passkey as an empty scaffold"
Level: info
Category: "docs"
Status: resolved
Package: "—"
Source: ".quality-metrics/passkey.json:42"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-011 — Package quality metrics and behavior-spec banner still describe passkey as an empty scaffold

`INFO` · `docs` · `—` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **resolved**

## Summary

The metrics file records a 9-LOC, single-file package whose index is export {} and flags "Empty public API despite five declared runtime dependencies" — while the package now ships roughly 1,500 LOC across five modules with a full API surface. Likewise spec/behaviors/17-passkey.md:15 still carries the banner "No code implementing it exists yet; awthaq is pre-implementation" even though every behavior it names is implemented (this stale banner is also why some evidence cites a spec written as aspiration). The cross-check required by the audit method resolved cleanly — BEH-EA-132/133/135's requirements do match the code — but the repo's own machine-readable picture of this domain is out of date.

## Evidence

Source: `.quality-metrics/passkey.json:42`

```
"fileCount": 1,
"totalLoc": 9,
```

## Recommended fix

Regenerate .quality-metrics/passkey.json and strip the pre-implementation banners from 17-passkey.md and the feature file once a package is implemented.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `quality-metrics-regeneration`. Duplicate of `DESS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `.quality-metrics/passkey.json:41`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
