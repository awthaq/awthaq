---
ID: "TC-004"
Title: "Signals API entirely absent; no browser-side passkey surface in any shipped package"
Level: medium
Category: "dx"
Status: ready-for-human
Package: "—"
Source: ".scratch/passkey/spec.md:360"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-004 — Signals API entirely absent; no browser-side passkey surface in any shipped package

`MEDIUM` · `dx` · `—` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **ready-for-human**

## Summary

The deferral is documented, but the practical cost lands on every integrator: when a user deletes a passkey (Passkey.ts:621-653) the credential manager keeps offering it forever, and an unknown-credential sign-in failure (Passkey.ts:551-553) gives the client nothing to act on — the two exact moments the research for this repo said should trigger signalUnknownCredential/signalAllAcceptedCredentials (.scratch/research/06-webauthn-passkeys.md:97, 149, 253). Beyond signals, grep finds zero passkey ceremony code in packages/client, packages/react, and packages/next: no mediation:'conditional' conditional-UI wiring, no autocomplete='username webauthn' guidance, no getClientCapabilities gating — every browser-side adoption behavior is left as an exercise. The repo's own model spec sets the bar: adoption 'depends on doing autofill/conditional-create correctly, not just exposing the two ceremony endpoints' (spec/models/03-passkey-webauthn.md:20).

## Evidence

Source: `.scratch/passkey/spec.md:360`

```
- The Signals API (`signalUnknownCredential`, `signalAllAcceptedCredentials`,
  `signalCurrentUserDetails`) — a real, documented WebAuthn L3 feature
  research recommends, but not named in any BEH-EA requirement;
```

## Recommended fix

Ship the loop at minimum as documented client guidance plus a typed, fire-and-forget signals helper in @awthaq/client (call signalAllAcceptedCredentials after successful removeCredential, signalUnknownCredential after a uniform auth failure driven by a stale credential). The server endpoints already exist; only the hygiene layer is missing.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`TC-008` — No Related Origin Requests support for multi-origin passkey deployments](info/TC-008-tim-cappalli.md) `_(tim-cappalli, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `passkey-browser-signals`. Already fixed by commit 0441226. Evidence at HEAD ec065a7: `packages/client/src/passkey/PasskeyClient.ts:284`. Fix: Add a typed, fire-and-forget Signals layer to @awthaq/client's passkeyClient: signalAllAcceptedCredentials after delete and after every successful authenticate, signalCurrentUserDetails after a profile-name change; expose signal capabilities in getClientCapabilities. Server supplies the needed rpId/userHandle/credential-id list. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-human.
