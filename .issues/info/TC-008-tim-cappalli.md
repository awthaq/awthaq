---
ID: "TC-008"
Title: "No Related Origin Requests support for multi-origin passkey deployments"
Level: info
Category: "api"
Status: needs-triage
Package: "—"
Source: ".scratch/passkey/spec.md:357"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-008 — No Related Origin Requests support for multi-origin passkey deployments

`INFO` · `api` · `—` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **needs-triage**

## Summary

The origins config is an exact-tuple array precisely so a www host and its apex can coexist (BEH-EA-133), but passkeys created on one origin are bound to that rpId-bound credential manager entry and other listed origins only benefit if the RP publishes /.well-known/webauthn (Related Origin Requests). The plugin ships no helper or route for serving that well-known document, and the deferral note is accurate — this only bites real multi-domain deployments, so it is an observation, not a defect.

## Evidence

Source: `.scratch/passkey/spec.md:357`

```
- Related Origin Requests (multi-domain passkeys via
  `/.well-known/webauthn`) — not mentioned in `spec/behaviors/17-passkey.md`
  and not requested; revisit if a real multi-domain deployment need arises.
```

## Recommended fix

When multi-domain demand appears, add a tiny optional handler that serves the validated RP-ID allow-list from config as /.well-known/webauthn with the correct content type.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`TC-004` — Signals API entirely absent; no browser-side passkey surface in any shipped package](medium/TC-004-tim-cappalli.md) `_(tim-cappalli, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `None`. Evidence at HEAD ec065a7: `.scratch/passkey/spec.md:357`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/13-repo-features-tooling.md`.
