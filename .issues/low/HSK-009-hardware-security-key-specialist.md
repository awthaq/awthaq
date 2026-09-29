---
ID: "HSK-009"
Title: "spec/models/03-passkey-webauthn.md is stale: claims pre-implementation and a two-minute challenge TTL"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/models/03-passkey-webauthn.md:67"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-009 — spec/models/03-passkey-webauthn.md is stale: claims pre-implementation and a two-minute challenge TTL

`LOW` · `docs` · `—` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **ready-for-agent**

## Summary

The model document's Status table says Planned-MVP, "What is missing" claims no Passkey class, no WebAuthn port implementation, and no challenge/replay handling exist, and the worked example quotes a two-minute TTL — while packages/passkey and packages/ports are fully implemented and the shipped ChallengeStore fixes a five-minute TTL (ChallengeStore.ts:56, matching BEH-EA-132 in spec/behaviors/17-passkey.md:91). The spec tree contradicts itself and the code; auditors and integrators reading the model doc first would wrongly conclude the domain is absent (and mis-state the replay window by 2.5x).

## Evidence

Source: `spec/models/03-passkey-webauthn.md:67`

```
Challenges are single-use verification rows with a two-minute TTL
```

## Recommended fix

Refresh spec/models/03-passkey-webauthn.md to Implemented status, drop the 'What is missing' list, and correct the TTL quote to five minutes to match BEH-EA-132 and the code.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-behavior-code-reconcile`. Evidence at HEAD ec065a7: `spec/models/03-passkey-webauthn.md:67`. Fix: Refresh model 03 to the shipped state and fix the TTL/storage misquote. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
