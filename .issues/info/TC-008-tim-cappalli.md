---
ID: "TC-008"
Title: "No Related Origin Requests support for multi-origin passkey deployments"
Level: info
Category: "api"
Status: resolved
Package: "—"
Source: ".scratch/passkey/spec.md:357"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-008 — No Related Origin Requests support for multi-origin passkey deployments

`INFO` · `api` · `—` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

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

**Resolved (2026-09-29):** Implemented WebAuthn Related Origin Requests, config-gated and off by default. `PasskeyConfig.relatedOrigins` (default []) lists exact https origins outside `rpId`; `checkOrigin` accepts them for register/authenticate/reauthenticate (exempt from the rpId host-suffix check like android origins; never an allowed top origin), the port's `expectedOrigin` is origins + relatedOrigins, a malformed entry (non-https, path, not an origin) refuses to build the layer, and a new anonymous group `passkey.wellKnown` serves `GET /.well-known/webauthn` as `{ origins }` JSON (404 `PasskeyRelatedOriginsNotConfigured` while empty). Tests: PasskeyCeremony.test.ts 'TC-008: related origins' (default refused, accepted on all three ceremonies with the port told to expect it, unlisted refused, not a top origin, bad config refuses to build), AuthHttp.test.ts (404 by default, JSON when configured), AuthComposition group list. Docs: passkey README config row and route list, spec/behaviors/17-passkey.md. Deployment note: the browser fetches the document from the rpId host, so route that path to the app.
