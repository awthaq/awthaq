---
ID: "BPAS-004"
Title: "User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag"
Level: medium
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/WebAuthn.ts:212"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-004 — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag

`MEDIUM` · `security` · `ports` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

The port's header says UV/UP *policy* is the plugin's job, but VerifiedRegistration/VerifiedAuthentication expose only userVerified — no userPresent field — so the plugin cannot enforce UP even if it wanted to, for any ceremony including ordinary registration and authentication. The FIDO server checklist the repo itself cites (research/06 line 25) requires UP/UV flag validation; conditional create is the only legitimate UP=0 flow. Practical exploitability is limited to holders of the credential private key, but combined with the default preferred UV policy and macOS Touch ID's always-zero counter (research/06 line 92), UP is the remaining gesture proof and it is simply not checked.

## Evidence

Source: `packages/ports/src/WebAuthn.ts:212`

```
requireUserPresence: false,
            requireUserVerification: false,
```

## Recommended fix

Surface userPresent (and the raw BE flag) from both verify results in the port, pass requireUserPresence:true by default for non-conditional ceremonies (or let the plugin check the surfaced flag), and enforce UP=1 on ordinary registration and all authentication assertions.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CB-002` — User-presence (UP) flag is never enforced in any ceremony](medium/CB-002-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-008` — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic](info/CB-008-christiaan-brand.md) `_(christiaan-brand, info)_`
- [`HSK-002` — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere](medium/HSK-002-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, medium)_`
- [`HSK-006` — "indirect" attestation conveyance is absent from the type](info/HSK-006-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`TC-006` — direct/enterprise attestation accepted with nothing behind it](low/TC-006-tim-cappalli.md) `_(tim-cappalli, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `webauthn-user-presence`. Duplicate of `CB-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/WebAuthn.ts:204`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CB-002-christiaan-brand` — closed by its fix (see that issue's Resolved comment).
